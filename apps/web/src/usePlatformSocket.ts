import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { WS_URL } from './config';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WsEventLog {
  at: string;
  type: string;
  summary: string;
}

export function usePlatformSocket() {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<WsEventLog | null>(null);

  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io(WS_URL, {
        transports: ['websocket'],
        autoConnect: true,
      });
    } catch {
      setStatus('error');
      return;
    }

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('error'));
    socket.on('platform.event', (payload: { type?: string; payload?: unknown }) => {
      setLastEvent({
        at: new Date().toISOString(),
        type: payload?.type ?? 'unknown',
        summary: JSON.stringify(payload?.payload ?? {}),
      });
    });

    return () => {
      socket?.disconnect();
    };
  }, []);

  return { status, lastEvent };
}
