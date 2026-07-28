import {
  DEFAULT_ROLE_PERMISSIONS,
  READ_ONLY_INTEGRATION_PERMISSIONS,
} from "@guildpass/shared-types";
import {
  hasPermission,
  requirePermission,
  PermissionDeniedError,
  resolvePermissions,
} from "./permissions";

describe("scoped permissions (#145)", () => {
  test("admin role defaults include all gated mutation permissions", () => {
    const perms = resolvePermissions({
      roles: [{ role: "admin", active: true }],
    });
    for (const permission of DEFAULT_ROLE_PERMISSIONS.admin) {
      expect(perms.has(permission)).toBe(true);
    }
  });

  test("contributor and member defaults preserve no admin mutation rights", () => {
    expect(
      hasPermission(
        { roles: [{ role: "contributor", active: true }] },
        "write:roles",
      ),
    ).toBe(false);
    expect(
      hasPermission(
        { roles: [{ role: "member", active: true }] },
        "write:overrides",
      ),
    ).toBe(false);
    expect(DEFAULT_ROLE_PERMISSIONS.contributor).toEqual([]);
    expect(DEFAULT_ROLE_PERMISSIONS.member).toEqual([]);
  });

  test("read-only integration scope can read but cannot mutate roles", () => {
    const principal = {
      roles: [],
      grantedPermissions: READ_ONLY_INTEGRATION_PERMISSIONS,
    };

    expect(hasPermission(principal, "read:access-decisions")).toBe(true);
    expect(hasPermission(principal, "read:overrides")).toBe(true);
    expect(hasPermission(principal, "write:roles")).toBe(false);
    expect(hasPermission(principal, "write:overrides")).toBe(false);
    expect(hasPermission(principal, "write:resources")).toBe(false);

    expect(() => requirePermission(principal, "read:overrides")).not.toThrow();
    expect(() => requirePermission(principal, "write:roles")).toThrow(
      PermissionDeniedError,
    );
  });

  test("inactive admin role does not grant permissions", () => {
    expect(
      hasPermission(
        { roles: [{ role: "admin", active: false }] },
        "write:roles",
      ),
    ).toBe(false);
  });
});
