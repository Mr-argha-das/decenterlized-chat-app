export type RealtimeConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface RealtimePacket<T = Record<string, unknown>> {
  event: string;
  data: T;
  ts?: string;
}

type PacketListener = (packet: RealtimePacket) => void;
type StateListener = (state: RealtimeConnectionState) => void;

export class RealtimeWebSocketClient {
  private ws: WebSocket | null = null;
  private getToken: () => string | null;
  private onAuthFailure?: () => Promise<string | null>;
  private listeners = new Set<PacketListener>();
  private stateListeners = new Set<StateListener>();
  private state: RealtimeConnectionState = "disconnected";
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerTs: string | null = null;

  constructor(opts: {
    getToken: () => string | null;
    onAuthFailure?: () => Promise<string | null>;
  }) {
    this.getToken = opts.getToken;
    this.onAuthFailure = opts.onAuthFailure;
  }

  private setState(next: RealtimeConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.stateListeners.forEach((cb) => cb(next));
  }

  getState(): RealtimeConnectionState {
    return this.state;
  }

  subscribe(listener: PacketListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  connect(): void {
    if (typeof window === "undefined") return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const token = this.getToken();
    if (!token) {
      this.setState("disconnected");
      return;
    }

    this.manualClose = false;
    this.clearTimers();
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ token });
    if (this.lastServerTs) {
      params.set("since", this.lastServerTs);
    }
    const url = `${proto}//${window.location.host}/ws?${params.toString()}`;

    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.startHeartbeat();
    };

    socket.onmessage = (ev) => {
      try {
        const packet = JSON.parse(String(ev.data)) as RealtimePacket;
        if (packet.ts) {
          this.lastServerTs = packet.ts;
        } else if (
          packet.event === "session.ready" &&
          typeof packet.data?.server_time === "string"
        ) {
          this.lastServerTs = packet.data.server_time;
        }
        this.listeners.forEach((cb) => cb(packet));
      } catch {
        // ignore malformed frames
      }
    };

    socket.onclose = async (ev) => {
      this.stopHeartbeat();
      if (this.ws === socket) {
        this.ws = null;
      }
      if (this.manualClose) {
        this.setState("disconnected");
        return;
      }
      if (ev.code === 4401 && this.onAuthFailure) {
        try {
          const newToken = await this.onAuthFailure();
          if (newToken && !this.manualClose) {
            this.scheduleReconnect(200);
            return;
          }
        } catch {
          this.setState("disconnected");
          return;
        }
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose handles reconnect backoff
    };
  }

  disconnect(): void {
    this.manualClose = true;
    this.lastServerTs = null;
    this.reconnectAttempt = 0;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, "Client logout");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setState("disconnected");
  }

  send(event: string, data: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ event, data }));
      return true;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(overrideMs?: number): void {
    if (this.manualClose) return;
    this.setState("reconnecting");
    const base =
      overrideMs ??
      Math.min(15_000, 500 * Math.pow(2, Math.min(this.reconnectAttempt, 6)));
    const jitter = Math.floor(Math.random() * 250);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, base + jitter);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send("ping", {});
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
