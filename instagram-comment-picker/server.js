require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { ApifyClient } = require('apify-client');

const app = express();
const PORT = process.env.PORT || 3000;
const META_API_VERSION = process.env.META_API_VERSION || 'v26.0';
const META_API_BASE = `https://graph.instagram.com/${META_API_VERSION}`;
const apifyClient = process.env.APIFY_TOKEN
  ? new ApifyClient({ token: process.env.APIFY_TOKEN })
  : null;

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
    params = undefined;
  }
  return items;
}

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Backend API is working!',
    metaConfigured: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID),
    apifyConfigured: Boolean(process.env.APIFY_TOKEN),
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
    : 1000;
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaUserId = process.env.META_IG_USER_ID;
  const shortcodeMatch = postUrl.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  const shortcode = shortcodeMatch?.[2];

  // First try Meta for media owned by the authorized Instagram Professional account.
  if (metaToken && metaUserId && shortcode) {
    try {
      const media = await getAllPages(`${META_API_BASE}/${encodeURIComponent(metaUserId)}/media`, {
        fields: 'id,permalink,media_type',
        limit: 100,
        access_token: metaToken,
      });
      const targetMedia = media.find(item =>
        item.permalink && normalizeInstagramUrl(item.permalink) === postUrl
      );

      if (targetMedia) {
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
          count: comments.length,
          comments,
        });
      }
      console.log('Meta: post is not in authorized account media; trying Apify if configured.');
    } catch (error) {
      const metaError = error.response?.data?.error;
      console.warn('Meta request failed; trying Apify fallback:', {
        status: error.response?.status || 502,
        code: metaError?.code,
        message: metaError?.message || error.message,
      });
    }
  }

  // Apify fallback supports eligible public posts, subject to actor access and usage quota.
  if (apifyClient) {
    try {
      const run = await apifyClient.actor('apify/instagram-comment-scraper').call({
        directUrls: [postUrl],
        resultsLimit: limit,
      });
      const { items = [] } = await apifyClient.dataset(run.defaultDatasetId).listItems({ limit });
      const comments = items.map((item, index) => ({
        id: item.id || `c_${index}`,
        username: item.ownerUsername || item.username || 'user',
        text: item.text || '',
        timestamp: item.timestamp || null,
      })).filter(item => item.text || item.username);

      return res.json({
        success: true,
        provider: 'apify',
        count: comments.length,
        comments,
      });
    } catch (error) {
      console.error('Apify request failed:', error.message);
      const message = /quota|monthly usage hard limit|usage hard limit/i.test(error.message || '')
        ? 'Apify usage limit has been reached. Increase/reset the Apify plan or import comments from a CSV, JSON, or TXT file.'
        : 'Apify could not fetch comments for this post. Check the Apify actor run and Render logs, or import a CSV, JSON, or TXT file.';
      return res.status(502).json({
        success: false,
        code: 'APIFY_FETCH_FAILED',
        error: message,
        metaAttempted: Boolean(metaToken && metaUserId),
      });
    }
  }

  return res.status(503).json({
    success: false,
    code: 'NO_PROVIDER_CONFIGURED',
    error: 'Set APIFY_TOKEN in Render to enable Apify. Meta is optional and works only for media accessible to the authorized Instagram Professional account. CSV, JSON, or TXT import remains available.',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
