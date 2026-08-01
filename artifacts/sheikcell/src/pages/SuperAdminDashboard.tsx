import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  api,
  type TenantSummary,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Building2, LogOut, Plus, Users, MessageSquare, Smartphone, KeyRound, Ban, CheckCircle2 } from "lucide-react";

// Painel do superadmin (dono do sistema): cria/suspende lojas (tenants)
// e gerencia o admin de cada loja. Nenhum dado operacional aparece aqui.
export default function SuperAdminDashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [adminFor, setAdminFor] = useState<TenantSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ name: "", adminName: "", adminEmail: "", adminPassword: "" });
  const [adminForm, setAdminForm] = useState({ name: "", email: "", password: "" });

  const load = () => {
    api.superadmin.listTenants()
      .then((r) => setTenants(r.tenants))
      .catch((e: Error) => toast({ title: "Erro ao carregar lojas", description: e.message, variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const createTenant = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      await api.superadmin.createTenant({
        name: form.name.trim(),
        adminName: form.adminName.trim() || undefined,
        adminEmail: form.adminEmail.trim() || undefined,
        adminPassword: form.adminPassword || undefined,
      });
      toast({ title: "Loja criada" });
      setCreateOpen(false);
      setForm({ name: "", adminName: "", adminEmail: "", adminPassword: "" });
      load();
    } catch (e) {
      toast({ title: "Erro ao criar loja", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const toggleActive = async (t: TenantSummary) => {
    try {
      await api.superadmin.updateTenant(t.id, { isActive: !t.isActive });
      toast({ title: t.isActive ? "Loja suspensa" : "Loja reativada" });
      load();
    } catch (e) {
      toast({ title: "Erro", description: (e as Error).message, variant: "destructive" });
    }
  };

  const saveAdmin = async () => {
    if (!adminFor || !adminForm.email.trim() || !adminForm.password) return;
    setBusy(true);
    try {
      await api.superadmin.upsertTenantAdmin(adminFor.id, {
        name: adminForm.name.trim() || undefined,
        email: adminForm.email.trim(),
        password: adminForm.password,
      });
      toast({ title: "Admin da loja salvo" });
      setAdminFor(null);
      setAdminForm({ name: "", email: "", password: "" });
      load();
    } catch (e) {
      toast({ title: "Erro", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="w-6 h-6 text-primary" />
          <div>
            <h1 className="font-bold leading-tight">Painel do Sistema</h1>
            <p className="text-xs text-muted-foreground">Superadmin · {user?.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-tenant">
            <Plus className="w-4 h-4 mr-1" /> Nova loja
          </Button>
          <Button size="sm" variant="ghost" onClick={logout} data-testid="button-logout">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <main className="p-4 max-w-5xl mx-auto space-y-3">
        {loading ? (
          <p className="text-muted-foreground text-sm">Carregando...</p>
        ) : tenants.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nenhuma loja cadastrada ainda.</p>
        ) : (
          tenants.map((t) => (
            <Card key={t.id} data-testid={`card-tenant-${t.id}`}>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {t.name}
                  {t.isActive
                    ? <Badge variant="secondary" className="text-green-700">Ativa</Badge>
                    : <Badge variant="destructive">Suspensa</Badge>}
                </CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setAdminFor(t); setAdminForm({ name: "", email: t.admins[0]?.email ?? "", password: "" }); }} data-testid={`button-admin-${t.id}`}>
                    <KeyRound className="w-4 h-4 mr-1" /> Admin
                  </Button>
                  <Button size="sm" variant={t.isActive ? "destructive" : "default"} onClick={() => toggleActive(t)} data-testid={`button-toggle-${t.id}`}>
                    {t.isActive ? <><Ban className="w-4 h-4 mr-1" /> Suspender</> : <><CheckCircle2 className="w-4 h-4 mr-1" /> Reativar</>}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground flex flex-wrap gap-4">
                <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {t.userCount} usuários</span>
                <span className="flex items-center gap-1"><MessageSquare className="w-4 h-4" /> {t.conversationCount} conversas</span>
                <span className="flex items-center gap-1"><Smartphone className="w-4 h-4" /> {t.whatsappCount} WhatsApp</span>
                {t.admins.length > 0 && (
                  <span>Admin: {t.admins.map((a) => `${a.name} (${a.email})`).join(", ")}</span>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </main>

      {/* Nova loja */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova loja (lojista)</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome da loja</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Celulares do João" data-testid="input-tenant-name" />
            </div>
            <p className="text-xs text-muted-foreground">Opcional: já criar o admin da loja (ele será obrigado a trocar a senha no primeiro acesso).</p>
            <div>
              <Label>Nome do admin</Label>
              <Input value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} data-testid="input-admin-name" />
            </div>
            <div>
              <Label>E-mail do admin</Label>
              <Input type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} data-testid="input-admin-email" />
            </div>
            <div>
              <Label>Senha inicial</Label>
              <Input type="text" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} data-testid="input-admin-password" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button onClick={createTenant} disabled={busy || !form.name.trim()} data-testid="button-save-tenant">Criar loja</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin da loja */}
      <Dialog open={!!adminFor} onOpenChange={(o) => { if (!o) setAdminFor(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Admin da loja {adminFor?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Cria um novo admin ou, se o e-mail já for de um admin desta loja, reseta a senha dele.
            </p>
            <div>
              <Label>Nome</Label>
              <Input value={adminForm.name} onChange={(e) => setAdminForm({ ...adminForm, name: e.target.value })} data-testid="input-upsert-admin-name" />
            </div>
            <div>
              <Label>E-mail</Label>
              <Input type="email" value={adminForm.email} onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })} data-testid="input-upsert-admin-email" />
            </div>
            <div>
              <Label>Nova senha</Label>
              <Input type="text" value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} data-testid="input-upsert-admin-password" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdminFor(null)}>Cancelar</Button>
            <Button onClick={saveAdmin} disabled={busy || !adminForm.email.trim() || adminForm.password.length < 6} data-testid="button-save-admin">Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
