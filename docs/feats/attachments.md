# Feature: Chat Attachments

## What it does

Users can attach images to chat messages. Images are uploaded to S3, stored as `project_attachments` in the DB, and rendered inline in the conversation. Clicking an image opens a fullscreen `ImageGallery` overlay.

Separate from the virtual filesystem (`project_files`) — attachments are ephemeral, per-conversation, and for images only.

## Architecture

```
User selects image in chat input
  ↓ POST /api/attachments (multipart)
      → validate mime + size
      → upload to S3: jiku/attachments/{projectId}/{conversationId}/{uuid}.{ext}
      → insert project_attachments row
      → return { id, url: /api/attachments/{id} }
  ↓ URL embedded in message content as image part
  ↓ Message sent via POST /api/conversations/:id/chat

GET /api/attachments/:id
  → auth check (user must be member of project)
  → proxy-stream from S3
```

## DB Schema

`project_attachments` table:
- `project_id`, `agent_id`, `conversation_id`, `user_id` — references
- `storage_key` — S3 key
- `filename`, `mime_type`, `size_bytes`
- `scope: 'per_user' | 'shared'`

## ImageGallery Component

`apps/studio/web/components/ui/image-gallery.tsx`:

```typescript
interface ImageGalleryProps {
  images: GalleryImage[]   // { src, alt?, filename? }
  initialIndex?: number
  open: boolean
  onClose: () => void
}
```

Features:
- Fullscreen overlay, image fit-to-screen
- Prev/next navigation (arrow key + button)
- Minimap thumbnail strip at bottom for multi-image navigation
- Click backdrop (outside image) closes gallery
- Opens at the clicked image index

## Conversation Viewer Integration

`conversation-viewer.tsx` extracts image URLs from message parts, renders `<img>` thumbnails, attaches `onClick` to open `ImageGallery` at the correct index.

## Known Limitations

- Images only (no PDF, video, audio as attachment)
- No bulk-delete on conversation delete (needs cleanup job)
- `scope: 'per_user'` not yet enforced on serve — all project members can access by ID

## Related Files

- `apps/studio/db/src/schema/attachments.ts`
- `apps/studio/server/src/routes/chat.ts` — upload + serve endpoints
- `apps/studio/web/components/ui/image-gallery.tsx`
- `apps/studio/web/components/chat/conversation-viewer.tsx`
- `apps/studio/web/components/agent/chat/chat-interface.tsx`
