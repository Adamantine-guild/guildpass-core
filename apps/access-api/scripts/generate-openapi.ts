import fs from 'fs';
import path from 'path';
import { buildApp } from '../src/app';

async function main() {
  const app = await buildApp();
  await app.ready();

  const openapiSpec = app.swagger();

  // Write to repository root docs folder
  const outPath = path.join(__dirname, '../../../docs/openapi.json');
  const outDir = path.dirname(outPath);
  
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outPath, JSON.stringify(openapiSpec, null, 2));
  console.log(`OpenAPI specification successfully written to ${outPath}`);

  await app.close();
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI specification:', err);
  process.exit(1);
});
