import {
    EventRepository,
    type Event,
    type EventRepositoryUpsertResult,
    type Filter
} from "@nostr-relay/common";
import { isExpired } from "./utils";

/** Array-backed event repository shared by the ws and wss listeners. */
export class InMemoryEventRepository extends EventRepository {
    readonly stored: Event[] = [];

    isSearchSupported(): boolean {
        return false;
    }

    upsert(event: Event): EventRepositoryUpsertResult {
        if (this.stored.some((stored) => stored.id === event.id)) {
            return { isDuplicate: true };
        }

        const key = replacementKey(event);
        const previousIndex =
            key === null
                ? -1
                : this.stored.findIndex((stored) => replacementKey(stored) === key);
        if (previousIndex >= 0) {
            const previous = this.stored[previousIndex];
            if (
                previous.created_at > event.created_at ||
                (previous.created_at === event.created_at &&
                    previous.id.localeCompare(event.id) < 0)
            ) {
                return { isDuplicate: true };
            }
            this.stored.splice(previousIndex, 1);
        }
        this.stored.unshift(event);
        return { isDuplicate: false };
    }

    find(filter: Filter): Event[] {
        return this.stored
            .filter((event) => matches(filter, event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit ?? 500);
    }

    async deleteByDeletionRequest(deletion: Event): Promise<void> {
        const ids = new Set(
            deletion.tags
                .filter((tag) => tag[0] === "e" && tag[1])
                .map((tag) => tag[1]),
        );
        const addresses = new Set(
            deletion.tags
                .filter((tag) => tag[0] === "a" && tag[1])
                .map((tag) => tag[1]),
        );
        for (let index = this.stored.length - 1; index >= 0; index--) {
            const event = this.stored[index];
            if (
                event.pubkey !== deletion.pubkey ||
                event.created_at > deletion.created_at
            ) {
                continue;
            }
            const address = `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""
                }`;
            if (ids.has(event.id) || addresses.has(address)) {
                this.stored.splice(index, 1);
            }
        }
    }

    destroy(): Promise<void> {
        return Promise.resolve();
    }
}

function replacementKey(event: Event): string | null {
    if (
        event.kind === 0 ||
        event.kind === 3 ||
        (event.kind >= 10_000 && event.kind < 20_000)
    ) {
        return `${event.pubkey}:${event.kind}`;
    }
    if (event.kind >= 30_000 && event.kind < 40_000) {
        const dTag = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
        return `${event.pubkey}:${event.kind}:${dTag}`;
    }
    return null;
}

function matches(filter: Filter, event: Event): boolean {
    if (isExpired(event)) {
        return false;
    }
    if (filter.ids && !filter.ids.some((id) => event.id.startsWith(id))) {
        return false;
    }
    if (filter.kinds && !filter.kinds.includes(event.kind)) {
        return false;
    }
    if (
        filter.authors &&
        !filter.authors.some((author) => event.pubkey.startsWith(author))
    ) {
        return false;
    }
    if (typeof filter.since === "number" && event.created_at < filter.since) {
        return false;
    }
    if (typeof filter.until === "number" && event.created_at > filter.until) {
        return false;
    }
    for (const [key, values] of Object.entries(filter)) {
        if (
            (!key.startsWith("#") && !key.startsWith("&")) ||
            !Array.isArray(values)
        ) {
            continue;
        }
        const tagName = key.slice(1);
        const hits = values.map((value) =>
            event.tags.some((tag) => tag[0] === tagName && tag[1] === value),
        );
        if (
            (key.startsWith("&") && hits.some((hit) => !hit)) ||
            (key.startsWith("#") && !hits.some(Boolean))
        ) {
            return false;
        }
    }
    return true;
}