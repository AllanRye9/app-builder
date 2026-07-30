import { handleUpload } from '@vercel/blob/client';

// This route never sees the file bytes. The browser calls @vercel/blob's
// client `upload()` helper, which POSTs *here* first to get a short-lived
// signed token, then PUTs the actual file straight to Blob storage. That's
// what makes large zips possible on Vercel at all — a normal Function
// route handling the multipart body directly would be capped at 4.5MB.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.toLowerCase().endsWith('.zip')) {
          throw new Error('Only .zip archives are accepted.');
        }
        return {
          allowedContentTypes: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // Nothing to do here — the frontend calls /api/start-build itself
        // once the client-side upload() promise resolves, rather than
        // relying on this webhook (which Vercel can only reach once the
        // deployment is public, making local dev awkward otherwise).
      },
    });

    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
