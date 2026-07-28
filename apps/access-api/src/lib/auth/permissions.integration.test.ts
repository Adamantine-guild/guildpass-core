/**
 * End-to-end style gate used by memberService/resourceService (#145).
 * Demonstrates a read-only integration principal cannot perform write:roles.
 */
import {
  READ_ONLY_INTEGRATION_PERMISSIONS,
  type Permission,
} from "@guildpass/shared-types";
import {
  requirePermission,
  PermissionDeniedError,
  type AuthzPrincipal,
} from "./permissions";

/** Mirrors the service-layer permission assertion. */
function gate(principal: AuthzPrincipal, permission: Permission) {
  requirePermission(principal, permission);
}

describe("read-only integration end-to-end gate (#145)", () => {
  const readOnlyIntegration: AuthzPrincipal = {
    roles: [{ role: "member", active: true }],
    grantedPermissions: READ_ONLY_INTEGRATION_PERMISSIONS,
  };

  test("may list/read overrides and access decisions", () => {
    expect(() => gate(readOnlyIntegration, "read:overrides")).not.toThrow();
    expect(() =>
      gate(readOnlyIntegration, "read:access-decisions"),
    ).not.toThrow();
  });

  test("cannot assign roles (write:roles) — mutation denied", () => {
    expect(() => gate(readOnlyIntegration, "write:roles")).toThrow(
      PermissionDeniedError,
    );
  });

  test("cannot create overrides or manage resources", () => {
    expect(() => gate(readOnlyIntegration, "write:overrides")).toThrow(
      PermissionDeniedError,
    );
    expect(() => gate(readOnlyIntegration, "write:resources")).toThrow(
      PermissionDeniedError,
    );
    expect(() => gate(readOnlyIntegration, "write:badges")).toThrow(
      PermissionDeniedError,
    );
  });

  test("admin wallet principal retains mutation rights", () => {
    const admin: AuthzPrincipal = {
      roles: [{ role: "admin", active: true }],
    };
    expect(() => gate(admin, "write:roles")).not.toThrow();
    expect(() => gate(admin, "write:resources")).not.toThrow();
  });
});
