"""Roles and permissions (RBAC).

Every endpoint is protected by ONE named permission (see `require` in dependencies.py). A user's role says
which permissions they have. Today there is a single role, `admin`, which has every permission, and every
account is an admin. Nothing in the code checks "is admin": it always checks the permission, so restricted
roles can be added later by editing ROLE_PERMISSIONS below (see "Adding roles" in the README).
"""

# Permission names. Format: area:action
ORDERS_READ = "orders:read"            # orders, dashboard, products
ORDERS_WRITE = "orders:write"          # create and edit orders
PRODUCTION_READ = "production:read"    # board, queue, printers, live updates
PRODUCTION_OPERATE = "production:operate"  # start and complete production steps
SCHEDULE_READ = "schedule:read"
SCHEDULE_MANAGE = "schedule:manage"    # plan and re-plan print jobs
RESOURCES_READ = "resources:read"
RESOURCES_MANAGE = "resources:manage"  # create, edit, activate and deactivate materials
STOCK_ADJUST = "stock:adjust"          # change stock quantities
QUALITY_READ = "quality:read"
QUALITY_INSPECT = "quality:inspect"    # record inspection results
QUALITY_RELEASE = "quality:release"    # release orders
USERS_MANAGE = "users:manage"          # create users, change roles, reset passwords
AUDIT_READ = "audit:read"

ALL_PERMISSIONS = frozenset({
    ORDERS_READ, ORDERS_WRITE, PRODUCTION_READ, PRODUCTION_OPERATE, SCHEDULE_READ, SCHEDULE_MANAGE,
    RESOURCES_READ, RESOURCES_MANAGE, STOCK_ADJUST, QUALITY_READ, QUALITY_INSPECT, QUALITY_RELEASE,
    USERS_MANAGE, AUDIT_READ,
})

DEFAULT_ROLE = "admin"  # the role of every new account for now

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": ALL_PERMISSIONS,
}


def is_valid_role(role: str) -> bool:
    return role in ROLE_PERMISSIONS


def permissions_for(role: str) -> frozenset[str]:
    """Unknown roles get nothing (deny by default)."""
    return ROLE_PERMISSIONS.get(role, frozenset())


def has_permission(role: str, permission: str) -> bool:
    return permission in permissions_for(role)
