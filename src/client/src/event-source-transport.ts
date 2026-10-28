import type { BoardEvent } from '../../shared/board.js';
import { eventsUrl } from './api.js';
import type { BoardTransport, ConnectionStatus } from './board-session.js';

const EVENT_TYPES = [
  'board_sync',
  'task_created',
  'task_updated',
  'task_moved',
  'task_deleted',
  'columns_updated',
] as const;

export class EventSourceTransport implements BoardTransport {
  private source: EventSource | undefined;

  connect(
    onEvent: (event: BoardEvent) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): void {
    this.close();

    const source = new EventSource(eventsUrl());
    this.source = source;

    source.addEventListener('open', () => {
      if (this.source !== source) return;
      onStatus('online');
    });

    // The browser reconnects on its own while readyState is CONNECTING;
    // CLOSED means a fatal response and only then is the stream gone.
    source.addEventListener('error', () => {
      if (this.source !== source) return;
      onStatus(
        source.readyState === EventSource.CLOSED ? 'offline' : 'connecting',
      );
    });

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        if (this.source !== source) return;
        onEvent(JSON.parse(event.data) as BoardEvent);
      });
    }
  }

  close(): void {
    this.source?.close();
    this.source = undefined;
  }
}
