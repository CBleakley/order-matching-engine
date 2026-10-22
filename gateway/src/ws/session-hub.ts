// Every open client WebSocket, with the counts the connection caps need and
// the authenticated connections of each session. A session (trader ID) may
// have several connections, one per browser tab; private updates for the
// session go to all of them.
import type { ServerMessage } from '@ome/shared';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// A server message before its connection stamps the `seq`.
export type OutgoingMessage = DistributiveOmit<ServerMessage, 'seq'>;

export interface HubConnection {
  readonly ip: string;
  send(message: OutgoingMessage): void;
  close(code: number, reason: string): void;
}

export class SessionHub<C extends HubConnection = HubConnection> {
  readonly #connections = new Set<C>();
  readonly #perIp = new Map<string, number>();
  readonly #sessions = new Map<number, Set<C>>();
  readonly #traderOf = new Map<C, number>();

  // Open connections, authenticated or not.
  get size(): number {
    return this.#connections.size;
  }

  countForIp(ip: string): number {
    return this.#perIp.get(ip) ?? 0;
  }

  // The session's authenticated connections.
  connectionsOf(traderId: number): readonly C[] {
    return [...(this.#sessions.get(traderId) ?? [])];
  }

  // Every authenticated connection.
  authenticated(): readonly C[] {
    return [...this.#traderOf.keys()];
  }

  add(connection: C): void {
    if (this.#connections.has(connection)) return;
    this.#connections.add(connection);
    this.#perIp.set(connection.ip, this.countForIp(connection.ip) + 1);
  }

  authenticate(connection: C, traderId: number): void {
    if (!this.#connections.has(connection) || this.#traderOf.has(connection)) return;
    this.#traderOf.set(connection, traderId);
    const set = this.#sessions.get(traderId);
    if (set === undefined) this.#sessions.set(traderId, new Set([connection]));
    else set.add(connection);
  }

  remove(connection: C): void {
    if (!this.#connections.delete(connection)) return;
    const count = this.countForIp(connection.ip) - 1;
    if (count > 0) this.#perIp.set(connection.ip, count);
    else this.#perIp.delete(connection.ip);

    const traderId = this.#traderOf.get(connection);
    if (traderId === undefined) return;
    this.#traderOf.delete(connection);
    const set = this.#sessions.get(traderId);
    set?.delete(connection);
    if (set?.size === 0) this.#sessions.delete(traderId);
  }

  // Sends to every authenticated connection of the session.
  sendToSession(traderId: number, message: OutgoingMessage): void {
    for (const connection of this.connectionsOf(traderId)) connection.send(message);
  }

  // Sends `message` (if any) to every connection, then closes it.
  closeAll(code: number, reason: string, message?: OutgoingMessage): void {
    for (const connection of [...this.#connections]) {
      if (message !== undefined) connection.send(message);
      connection.close(code, reason);
    }
  }
}
