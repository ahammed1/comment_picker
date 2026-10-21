require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const META_API_VERSION = process.env.META_API_VERSION || 'v26.0';
const META_API_BASE = `https://graph.instagram.com/${META_API_VERSION}`;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeInstagramUrl(value) {
  try {
    const url = new URL(value);
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    return match ? `https://www.instagram.com/${match[1]}/${match[2]}/` : null;
  } catch {
    return null;
  }
}

async function getAllPages(firstUrl, firstParams = {}) {
  const items = [];
  let url = firstUrl;
  let params = firstParams;

  while (url) {
    const response = await axios.get(url, { params, timeout: 30000 });
    const body = response.data || {};
    if (Array.isArray(body.data)) items.push(...body.data);
    url = body.paging?.next || null;
    params = undefined; // paging.next already contains its query parameters
  }
  return items;
}

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Backend API is working!',
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID),
  });
});

app.post('/api/fetch-comments', async (req, res) => {
  const requestedUrl = normalizeInstagramUrl(req.body?.postUrl);
  if (!requestedUrl) {
    return res.status(400).json({ success: false, error: 'Enter a valid Instagram post or Reel URL.' });
  }

  const requestedLimit = Number.parseInt(req.body?.limit, 10);
  const commentLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 10000)
    : 10000;

  const accessToken = process.env.META_ACCESS_TOKEN;
  const instagramUserId = process.env.META_IG_USER_ID;

  if (!accessToken || !instagramUserId) {
    return res.status(503).json({
      success: false,
      code: 'META_NOT_CONFIGURED',
      error: 'Meta API is not configured yet. Set META_ACCESS_TOKEN and META_IG_USER_ID in Render Environment after authorizing the client’s Instagram Professional account. You can still import a CSV, JSON, or TXT comments file.',
    });
  }

  try {
    // Instagram Login API: the token and IG user ID must belong to the authorized
    // professional account. Never accept access tokens from browser requests.
    const media = await getAllPages(
      `${META_API_BASE}/${encodeURIComponent(instagramUserId)}/media`,
      {
        fields: 'id,permalink,media_type',
        limit: 100,
        access_token: accessToken,
      }
    );

    const targetMedia = media.find(item =>
      item.permalink && normalizeInstagramUrl(item.permalink) === requestedUrl
    );

    if (!targetMedia) {
      return res.status(404).json({
        success: false,
        code: 'META_POST_NOT_FOUND',
        error: 'This post was not found in the authorized Instagram account’s accessible media. Confirm the account authorization and exact post URL. Meta API cannot fetch arbitrary posts just from their public URL.',
      });
    }

    const comments = [];
    let nextUrl = `${META_API_BASE}/${encodeURIComponent(targetMedia.id)}/comments`;
    let params = {
      fields: 'id,text,username,timestamp',
      limit: 100,
      access_token: accessToken,
    };

    while (nextUrl && comments.length < commentLimit) {
      const response = await axios.get(nextUrl, { params, timeout: 30000 });
      const body = response.data || {};

      if (Array.isArray(body.data)) {
        for (const item of body.data) {
          if (comments.length >= commentLimit) break;
          comments.push({
            id: item.id,
            username: item.username || 'user',
            text: item.text || '',
            timestamp: item.timestamp || null,
          });
        }
      }

      nextUrl = body.paging?.next || null;
      params = undefined;
    }

    return res.json({
      success: true,
      provider: 'meta_graph_api',
      count: comments.length,
      comments,
    });
  } catch (error) {
    const status = error.response?.status || 502;
    const metaError = error.response?.data?.error;
    // Avoid logging access tokens or full request URLs.
    console.error('Meta Instagram API request failed:', {
      status,
      code: metaError?.code,
      subcode: metaError?.error_subcode,
      message: metaError?.message || error.message,
    });

    if (status === 401 || status === 403) {
      return res.status(502).json({
        success: false,
        code: 'META_AUTH_OR_PERMISSION_ERROR',
        error: 'Meta rejected the token or permissions. Re-authorize the client’s Instagram Professional account and verify instagram_business_basic and instagram_business_manage_comments are granted.',
      });
    }

    return res.status(502).json({
      success: false,
      code: 'META_API_ERROR',
      error: metaError?.message || 'Meta API request failed. Check the Render logs for the Meta error code and message.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
