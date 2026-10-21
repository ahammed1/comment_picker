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

function getInstagramShortcode(value) {
  try {
    const url = new URL(value);
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return null;
    return url.pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[1] || null;
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
    params = undefined;
  }
  return items;
}

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Backend API is working!',
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID),
    provider: 'meta_only',
  });
});

app.get('/api/meta-status', async (_req, res) => {
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(503).json({
      success: false,
      configured: false,
      error: 'Set META_ACCESS_TOKEN in Render.',
    });
  }

  try {
    const response = await axios.get(`${META_API_BASE}/me`, {
      params: {
        fields: 'user_id,username',
        access_token: accessToken,
      },
      timeout: 15000,
    });

    return res.json({
      success: true,
      configured: true,
      account: {
        id: response.data.user_id,
        username: response.data.username || null,
      },
      message: 'Instagram Login credentials were accepted.',
    });
  } catch (error) {
    const metaError = error.response?.data?.error;

    return res.status(502).json({
      success: false,
      configured: true,
      error: metaError?.message || 'Instagram could not validate the access token.',
    });
  }
});

app.post('/api/fetch-comments', async (req, res) => {
  const postUrl = normalizeInstagramUrl(req.body?.postUrl);
  if (!postUrl) {
    return res.status(400).json({ success: false, error: 'Enter a valid Instagram post or Reel URL.' });
  }

  const requestedLimit = Number.parseInt(req.body?.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 10000)
    : 10000;
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaUserId = process.env.META_IG_USER_ID;

  if (!metaToken || !metaUserId) {
    return res.status(503).json({
      success: false,
      code: 'META_NOT_CONFIGURED',
      error: 'Meta is not configured. Set META_ACCESS_TOKEN and META_IG_USER_ID in Render. CSV, JSON, or TXT import is still available.',
    });
  }

  try {
    const media = await getAllPages(`${META_API_BASE}/${encodeURIComponent(metaUserId)}/media`, {
      fields: 'id,permalink,media_type',
      limit: 100,
      access_token: metaToken,
    });

    const requestedShortcode = getInstagramShortcode(postUrl);
    const targetMedia = media.find(item =>
      item.permalink && getInstagramShortcode(item.permalink) === requestedShortcode
    );

    if (!targetMedia) {
      console.warn('Meta media lookup did not find submitted post:', {
        authorizedUserId: metaUserId,
        mediaItemsReturned: media.length,
        requestedShortcode,
      });
      return res.status(404).json({
        success: false,
        code: 'META_MEDIA_NOT_FOUND',
        mediaItemsReturned: media.length,
        error: `Meta could not match this Instagram post to the authorized account's media. Meta returned ${media.length} media items for that account, but none matched the post URL. Confirm the post is published on this account and accessible through the Instagram API. Apify is disabled. You can still import comments from CSV, JSON, or TXT.`,
      });
    }

    const comments = [];
    let nextUrl = `${META_API_BASE}/${encodeURIComponent(targetMedia.id)}/comments`;
    let params = {
      fields: 'id,text,username,timestamp',
      limit: 100,
      access_token: metaToken,
    };

    while (nextUrl && comments.length < limit) {
      const response = await axios.get(nextUrl, { params, timeout: 30000 });
      const body = response.data || {};
      for (const item of (Array.isArray(body.data) ? body.data : [])) {
        if (comments.length >= limit) break;
        comments.push({
          id: item.id,
          username: item.username || 'user',
          text: item.text || '',
          timestamp: item.timestamp || null,
        });
      }
      nextUrl = body.paging?.next || null;
      params = undefined;
    }

    return res.json({
      success: true,
      provider: 'meta_graph_api',
      requestedLimit: limit,
      count: comments.length,
      comments,
      message: comments.length < limit
        ? 'Meta returned fewer comments than requested; this may be the number available through the API.'
        : 'Requested comment limit reached.',
    });
  } catch (error) {
    const metaError = error.response?.data?.error;
    const message = metaError?.message || error.message || 'Meta could not fetch comments.';
    console.error('Meta comment fetch failed:', {
      status: error.response?.status || 502,
      code: metaError?.code,
      message,
    });

    return res.status(502).json({
      success: false,
      code: 'META_FETCH_FAILED',
      error: `Meta API request failed: ${message}. Apify is disabled. Check the Instagram API permissions and whether the authorized account can access this Reel. CSV, JSON, or TXT import remains available.`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
