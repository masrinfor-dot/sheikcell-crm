let baseUrl = "";

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, "");
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${baseUrl}/api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export type User = {
  id: number;
  name: string;
  email: string;
  role: string;
  sectorId: number | null;
  sector: Sector | null;
};

export type Sector = {
  id: number;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  isActive: boolean;
};

export type QueueEntry = {
  id: number;
  clientName: string;
  clientContact: string | null;
  sectorId: number;
  channel: string;
  status: string;
  attendantId: number | null;
  notes: string | null;
  position: number;
  calledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SectorSummary = {
  sector: Sector;
  waiting: number;
  inProgress: number;
  completedToday: number;
  totalAttendants: number;
  busyAttendants: number;
};

export type AttendanceLog = {
  id: number;
  queueEntryId: number;
  clientName: string;
  clientContact: string | null;
  sectorId: number;
  sectorName: string;
  attendantId: number | null;
  attendantName: string | null;
  channel: string;
  outcome: string | null;
  notes: string | null;
  waitTimeSeconds: number | null;
  serviceTimeSeconds: number | null;
  createdAt: string;
};

export const api = {
  auth: {
    login: (email: string, password: string) =>
      req<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    logout: () =>
      req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
    me: () => req<{ user: User }>("/auth/me"),
  },
  sectors: {
    list: () => req<Sector[]>("/sectors"),
  },
  queue: {
    list: (params?: { sectorId?: number; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.status) qs.set("status", params.status);
      const query = qs.toString();
      return req<QueueEntry[]>(`/queue${query ? "?" + query : ""}`);
    },
    add: (data: {
      clientName: string;
      clientContact?: string;
      sectorId: number;
      channel?: string;
      notes?: string;
    }) =>
      req<QueueEntry>("/queue", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    call: (id: number) =>
      req<QueueEntry>(`/queue/${id}/call`, { method: "PATCH" }),
    complete: (id: number) =>
      req<QueueEntry>(`/queue/${id}/complete`, { method: "PATCH" }),
    transfer: (id: number, targetSectorId: number) =>
      req<QueueEntry>(`/queue/${id}/transfer`, {
        method: "PATCH",
        body: JSON.stringify({ targetSectorId }),
      }),
    remove: (id: number) =>
      req<{ ok: boolean }>(`/queue/${id}`, { method: "DELETE" }),
  },
  admin: {
    summary: () => req<SectorSummary[]>("/admin/summary"),
    logs: (params?: { limit?: number; sectorId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      const query = qs.toString();
      return req<AttendanceLog[]>(`/admin/logs${query ? "?" + query : ""}`);
    },
  },
};
