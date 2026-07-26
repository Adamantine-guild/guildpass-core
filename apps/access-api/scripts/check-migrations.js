#!/usr/bin/env node
/**
 * Migration safety check script for GuildPass
 * Checks for unsafe patterns in migration SQL
 */

const fs = require('fs');
const path = require('path');
const { exit } = require('process');

const MIGRATIONS_DIR = path.join(__dirname, '../prisma/migrations');

// Patterns to check
const UNSAFE_PATTERNS = [
  {
    name: 'Non-concurrent index creation',
    pattern: /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/gi,
    severity: 'HIGH',
    message: 'Consider using CREATE INDEX CONCURRENTLY for large/hot tables'
  },
  {
    name: 'Adding NOT NULL constraint without existing null check',
    pattern: /ALTER\s+TABLE.*ALTER\s+COLUMN.*SET\s+NOT\s+NULL/gi,
    severity: 'MEDIUM',
    message: 'Make sure all existing rows have a non-null value first'
  }
];

// Hot tables (large or write-heavy)
const HOT_TABLES = [
  'outbox_events',
  'memberships',
  'members',
  'audit_events'
];

function checkMigrationFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const issues = [];

  for (const check of UNSAFE_PATTERNS) {
    let match;
    while ((match = check.pattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;

      // Check if it's on a hot table
      const isHotTable = HOT_TABLES.some(table =>
        content.substring(Math.max(0, match.index - 100), match.index + 100).includes(table)
      );

      issues.push({
        check: check.name,
        line: lineNum,
        match: match[0],
        severity: check.severity,
        message: check.message,
        isHotTable
      });
    }
  }

  return issues;
}

function main() {
  console.log('🔍 Checking migration files for unsafe patterns...\n');
  let foundIssues = false;

  const migrationDirs = fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));

  for (const dir of migrationDirs) {
    const migrationFile = path.join(MIGRATIONS_DIR, dir.name, 'migration.sql');
    if (!fs.existsSync(migrationFile)) continue;

    const issues = checkMigrationFile(migrationFile);
    if (issues.length > 0) {
      foundIssues = true;
      console.log(`📁 Migration: ${dir.name}`);
      for (const issue of issues) {
        const severityEmoji = issue.severity === 'HIGH' ? '⚠️' : '⚠️';
        const hotIndicator = issue.isHotTable ? ' [HOT TABLE]' : '';
        console.log(`  ${severityEmoji} Line ${issue.line}: ${issue.check}${hotIndicator}`);
        console.log(`     Match: ${issue.match}`);
        console.log(`     Message: ${issue.message}`);
      }
      console.log('');
    }
  }

  if (!foundIssues) {
    console.log('✅ No unsafe migration patterns detected');
    exit(0);
  } else {
    console.log('❌ Found potential issues! Please review before merging.');
    exit(1);
  }
}

main();
