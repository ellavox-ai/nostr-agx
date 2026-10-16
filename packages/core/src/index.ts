/**
 * @nostr-agx/core — NIP-AGX protocol core (transport-agnostic).
 *
 * Owns what makes an AGX exchange correct + interoperable by default: task
 * lifecycle, correlation, receipts, replay protection, capability matching, and
 * content-type dispatch — over an injected {@link AgxTransport}. An adopting
 * runtime only decides what to do with a task (register a handler; return a
 * result). The Nostr binding lives in `@nostr-agx/nostr`.
 */

export const AGX_CORE_VERSION = "0.4.0";

export * from "./capability";
export * from "./client";
export * from "./errors";
export * from "./id";
export * from "./logger";
export * from "./seen-store";
export * from "./task";
export * from "./transport";
export * from "./wire";
