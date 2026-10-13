import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import type { PlatformEvent } from '@amp/core';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  },
})
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    const hello: PlatformEvent = {
      type: 'connection.hello',
      timestamp: new Date().toISOString(),
      payload: {
        message: 'Connected to AI Modernization Platform local-agent',
        serverTime: new Date().toISOString(),
      },
    };
    client.emit('platform.event', hello);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() _client: Socket, @MessageBody() _body: unknown): PlatformEvent {
    return {
      type: 'connection.hello',
      timestamp: new Date().toISOString(),
      payload: {
        message: 'pong',
        serverTime: new Date().toISOString(),
      },
    };
  }

  emitEvent(event: PlatformEvent): void {
    this.server?.emit('platform.event', event);
  }
}
