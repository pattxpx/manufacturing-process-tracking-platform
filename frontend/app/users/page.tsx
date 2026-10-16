"use client";

import { useState } from "react";
import { Badge } from "@/components/Badge";
import { ConfirmDialog, Dialog } from "@/components/Dialog";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import {
  Alert, Button, Card, EmptyState, LoadingBlock, PageHeader, Table, Tbody, Td, TextField, Th, Thead, Tr,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { useLiveData } from "@/lib/hooks";
import type { AppUser, RoleInfo } from "@/lib/types";

type Dialogs =
  | { kind: "create" }
  | { kind: "edit"; user: AppUser }
  | { kind: "reset"; user: AppUser }
  | { kind: "toggle"; user: AppUser };

export default function UsersPage() {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const users = useLiveData(() => api<AppUser[]>("/api/users"));
  const roles = useLiveData(() => api<RoleInfo[]>("/api/users/roles"));
  const [dialog, setDialog] = useState<Dialogs | null>(null);

  const roleOptions = (roles.data ?? []).map((r) => ({ value: r.name, label: r.name, hint: `${r.permissions.length} permissions` }));

  if (!can("users:manage")) {
    return <><PageHeader title="Users" /><Alert kind="warning">You do not have permission to manage users.</Alert></>;
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Only administrators can create accounts or change roles. There is no public sign-up."
        actions={<Button onClick={() => setDialog({ kind: "create" })}>Add user</Button>}
      />
      <div className="mb-4">
        <Alert kind="info" title="Everyone is an administrator for now">
          Every account has the <strong>admin</strong> role, which allows everything. The permission checks are
          already in place on the server, so restricted roles can be added later without changing the screens.
        </Alert>
      </div>
      {users.error && <div className="mb-4"><Alert kind="error" onRetry={users.reload}>{users.error}</Alert></div>}
      {users.loading && !users.data && <LoadingBlock />}

      {users.data && (
        <Card flush>
          {users.data.length === 0 ? <EmptyState title="No users yet" /> : (
            <Table label="Users">
              <Thead>
                <Tr><Th>User name</Th><Th>Name</Th><Th>Role</Th><Th>Status</Th><Th>Last sign-in</Th><Th><span className="sr-only">Actions</span></Th></Tr>
              </Thead>
              <Tbody>
                {users.data.map((u) => (
                  <Tr key={u.id}>
                    <Td label="User name" className="break-all font-medium text-slate-900">
                      {u.username}{u.id === me?.id && <span className="ml-2 text-xs font-normal text-slate-600">(you)</span>}
                    </Td>
                    <Td label="Name" className="break-words">{u.full_name}</Td>
                    <Td label="Role"><Badge tone="slate">{u.role}</Badge></Td>
                    <Td label="Status">{u.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Deactivated</Badge>}</Td>
                    <Td label="Last sign-in" className="whitespace-nowrap text-slate-600">{formatDateTime(u.last_login_at)}</Td>
                    <Td className="max-md:justify-end">
                      <div className="flex flex-wrap gap-2 max-md:justify-end">
                        <Button variant="secondary" onClick={() => setDialog({ kind: "edit", user: u })} aria-label={`Edit ${u.username}`}>Edit</Button>
                        <Button variant="secondary" onClick={() => setDialog({ kind: "reset", user: u })} aria-label={`Reset password of ${u.username}`}>Reset password</Button>
                        <Button variant="secondary" disabled={u.id === me?.id && u.is_active}
                          onClick={() => setDialog({ kind: "toggle", user: u })}
                          aria-label={`${u.is_active ? "Deactivate" : "Activate"} ${u.username}`}>
                          {u.is_active ? "Deactivate" : "Activate"}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>
      )}

      {dialog?.kind === "create" && (
        <CreateUserDialog roleOptions={roleOptions} onClose={() => setDialog(null)}
          onDone={(name) => { toast("success", `User ${name} created`); setDialog(null); users.reload(); }} />
      )}
      {dialog?.kind === "edit" && (
        <EditUserDialog user={dialog.user} roleOptions={roleOptions} onClose={() => setDialog(null)}
          onDone={() => { toast("success", "User updated"); setDialog(null); users.reload(); }} />
      )}
      {dialog?.kind === "reset" && (
        <ResetPasswordDialog user={dialog.user} onClose={() => setDialog(null)}
          onDone={() => { toast("success", `Password reset for ${dialog.user.username}. Their sessions were ended.`); setDialog(null); }} />
      )}
      {dialog?.kind === "toggle" && (
        <ToggleDialog user={dialog.user} onClose={() => setDialog(null)}
          onDone={() => { toast("success", `${dialog.user.username} ${dialog.user.is_active ? "deactivated" : "activated"}`); setDialog(null); users.reload(); }} />
      )}
    </>
  );
}

function CreateUserDialog({ roleOptions, onClose, onDone }: {
  roleOptions: { value: string; label: string }[]; onClose: () => void; onDone: (username: string) => void;
}) {
  const [form, setForm] = useState({ username: "", full_name: "", password: "", role: "admin" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/users", { method: "POST", body: form });
      onDone(form.username);
    } catch (err) {
      setError(errorText(err)); // the form keeps what was typed
      setBusy(false);
    }
  }

  return (
    <Dialog title="Add user" description="The new person signs in with this password and should change it on the Account page."
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} onClick={save}>Create user</Button></>}>
      <TextField label="User name" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
        autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={50} hint="3 to 50 letters, digits, dots, dashes or underscores." />
      <TextField label="Full name" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} maxLength={100} />
      <TextField label="Temporary password" required type="password" value={form.password} autoComplete="new-password"
        onChange={(e) => setForm({ ...form, password: e.target.value })} maxLength={128} hint="At least 12 characters, and not containing the user name." />
      <Select label="Role" value={form.role} onChange={(role) => setForm({ ...form, role })} options={roleOptions} />
      {error && <Alert kind="error">{error}</Alert>}
    </Dialog>
  );
}

function EditUserDialog({ user, roleOptions, onClose, onDone }: {
  user: AppUser; roleOptions: { value: string; label: string }[]; onClose: () => void; onDone: () => void;
}) {
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState(user.role);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: { full_name: fullName, role } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Edit ${user.username}`} description="Changing the role signs the person out so that the new role applies at their next sign-in."
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} onClick={save}>Save changes</Button></>}>
      <TextField label="Full name" required value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} />
      <Select label="Role" value={role} onChange={setRole} options={roleOptions} />
      {error && <Alert kind="error">{error}</Alert>}
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: AppUser; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/users/${user.id}/reset-password`, { method: "POST", body: { new_password: password } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Reset password for ${user.username}`} description="All of their current sessions are ended."
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} onClick={save}>Reset password</Button></>}>
      <TextField label="New temporary password" required type="password" autoComplete="new-password" value={password}
        onChange={(e) => setPassword(e.target.value)} maxLength={128} hint="At least 12 characters." />
      {error && <Alert kind="error">{error}</Alert>}
    </Dialog>
  );
}

function ToggleDialog({ user, onClose, onDone }: { user: AppUser; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: { is_active: !user.is_active } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog
      title={`${user.is_active ? "Deactivate" : "Activate"} ${user.username}?`}
      message={<>
        {user.is_active ? "They are signed out immediately and cannot sign in again until reactivated. Their history is kept." : "They will be able to sign in again."}
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
      </>}
      confirmLabel={user.is_active ? "Deactivate" : "Activate"} danger={user.is_active} busy={busy}
      onConfirm={confirm} onCancel={onClose}
    />
  );
}
