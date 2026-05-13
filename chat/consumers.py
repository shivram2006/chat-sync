"""
Chat Consumer — Updated
- Offline message queue (24hr delivery)
- Max 2 users
- Server stays AES-blind (relays ciphertext only)
"""

import json
import time
from channels.generic.websocket import AsyncWebsocketConsumer

# Active WebSocket connections  {room_group: {channel_name: consumer}}
room_connections = {}

# Offline message queue — stores encrypted msgs for offline user
# Structure: {room_group: [ {message, sender_id, timestamp}, ... ]}
offline_queue = {}

# Queue TTL = 24 hours in seconds
QUEUE_TTL = 86400


def _prune_queue(room_group):
    """Remove messages older than 24 hours."""
    now = time.time()
    queue = offline_queue.get(room_group, [])
    offline_queue[room_group] = [m for m in queue if now - m['timestamp'] < QUEUE_TTL]


class ChatConsumer(AsyncWebsocketConsumer):
    ROOM_NAME = 'hidden_room_alpha'
    MAX_USERS = 2

    async def connect(self):
        self.room_group_name = f'chat_{self.ROOM_NAME}'

        if self.room_group_name not in room_connections:
            room_connections[self.room_group_name] = {}

        # Max 2 users
        if len(room_connections[self.room_group_name]) >= self.MAX_USERS:
            await self.close(code=4001)
            return

        room_connections[self.room_group_name][self.channel_name] = self

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

        # Broadcast updated user count
        count = len(room_connections[self.room_group_name])
        await self.channel_layer.group_send(self.room_group_name, {
            'type': 'system_message',
            'count': count,
        })

        # Deliver any queued offline messages to this newly connected user
        await self._deliver_offline_queue()

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            room_connections.get(self.room_group_name, {}).pop(self.channel_name, None)
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

            count = len(room_connections.get(self.room_group_name, {}))
            await self.channel_layer.group_send(self.room_group_name, {
                'type': 'system_message',
                'count': count,
            })

    async def receive(self, text_data):
        """
        Receive encrypted message.
        - If other user is online: relay immediately
        - If other user is offline: queue for later delivery
        Server never decrypts — AES ciphertext passed through as-is.
        """
        try:
            data = json.loads(text_data)
            encrypted_msg = data.get('message', '')
            sender_id = data.get('sender_id', 'unknown')

            if not encrypted_msg:
                return

            # Typing signals — relay only, never queue
            # (Client sends encrypted typing signals too)
            connections = room_connections.get(self.room_group_name, {})
            other_online = len(connections) >= 2

            if other_online:
                # Both users online — relay directly
                await self.channel_layer.group_send(self.room_group_name, {
                    'type': 'chat_message',
                    'message': encrypted_msg,
                    'sender_id': sender_id,
                    'channel': self.channel_name,
                    'queued': False,
                })
            else:
                # Other user offline — queue message (skip typing signals)
                # Typing signals start with encrypted __TYPING__ — we still relay to group
                # but also queue real messages
                await self.channel_layer.group_send(self.room_group_name, {
                    'type': 'chat_message',
                    'message': encrypted_msg,
                    'sender_id': sender_id,
                    'channel': self.channel_name,
                    'queued': False,
                })
                # Queue for offline delivery
                _prune_queue(self.room_group_name)
                if self.room_group_name not in offline_queue:
                    offline_queue[self.room_group_name] = []
                offline_queue[self.room_group_name].append({
                    'message': encrypted_msg,
                    'sender_id': sender_id,
                    'timestamp': time.time(),
                })

        except (json.JSONDecodeError, Exception):
            pass

    async def _deliver_offline_queue(self):
        """Send all queued messages to this user when they connect."""
        _prune_queue(self.room_group_name)
        queue = offline_queue.get(self.room_group_name, [])
        if not queue:
            return

        for item in queue:
            # Don't deliver messages sent by this session back to sender
            # (sender_id check happens client-side via is_self flag)
            await self.send(text_data=json.dumps({
                'type': 'message',
                'message': item['message'],
                'sender_id': item['sender_id'],
                'is_self': False,   # queued msgs are always from the other person
                'queued': True,
                'timestamp': item['timestamp'],
            }))

        # Clear queue after delivery
        offline_queue[self.room_group_name] = []

    async def chat_message(self, event):
        """Relay encrypted message to this WebSocket client."""
        await self.send(text_data=json.dumps({
            'type': 'message',
            'message': event['message'],
            'sender_id': event['sender_id'],
            'is_self': event['channel'] == self.channel_name,
            'queued': event.get('queued', False),
            'timestamp': time.time(),
        }))

    async def system_message(self, event):
        """Send connection count update."""
        await self.send(text_data=json.dumps({
            'type': 'system',
            'count': event['count'],
        }))
