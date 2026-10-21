require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { ApifyClient } = require('apify-client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Apify Client (fallback for external posts)
const apifyClient = process.env.APIFY_TOKEN ? new ApifyClient({ token: process.env.APIFY_TOKEN }) : null;

app.post('/api/fetch-comments', async (req, res) => {
  const { postUrl, limit = 1000 } = req.body;
  const parsedLimit = Number.parseInt(limit, 10);
  const commentLimit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 5000)
    : 1000;

  if (!postUrl || !/^https?:\/\/(www\.)?instagram\.com\//i.test(postUrl)) {
    return res.status(400).json({ error: 'A valid Instagram URL is required.' });
  }

  const match = postUrl.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
  const shortcode = match ? match[2] : null;

  // -------------------------------------------------------------
  // STRATEGY 1: Official Meta Graph API (Free & Unlimited for your posts)
  // -------------------------------------------------------------
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaUserId = process.env.META_IG_USER_ID;

  if (metaToken && metaUserId && shortcode) {
    try {
      console.log(`Checking Meta Graph API for shortcode: ${shortcode}...`);
      
      // Find Media ID matching the shortcode
      const mediaRes = await axios.get(`https://graph.instagram.com/v26.0/${metaUserId}/media`, {
        params: { fields: 'id,permalink', access_token: metaToken, limit: 100 },
      });

      const mediaList = mediaRes.data.data || [];
      const targetMedia = mediaList.find(m => m.permalink && m.permalink.includes(shortcode));

      if (targetMedia) {
        console.log(`Found matching post on Meta account! Media ID: ${targetMedia.id}`);
        let allComments = [];
        let nextUrl = `https://graph.instagram.com/v26.0/${targetMedia.id}/comments?fields=id,text,username,timestamp&limit=50&access_token=${metaToken}`;

        while (nextUrl && allComments.length < commentLimit) {
          const commentRes = await axios.get(nextUrl);
          const data = commentRes.data;

          if (data.data && Array.isArray(data.data)) {
            data.data.forEach(item => {
              allComments.push({
                id: item.id,
                username: item.username || 'user',
                text: item.text || '',
                timestamp: item.timestamp,
              });
            });
          }
          nextUrl = data.paging?.next || null;
        }

        return res.json({
          success: true,
          provider: 'meta_graph_api',
          count: allComments.length,
          comments: allComments,
        });
      } else {
        console.log('Post not found on authorized Meta account. Trying fallback...');
      }
    } catch (metaErr) {
      console.warn('Meta API check failed or post not on this account:', metaErr.message);
    }
  }

  // -------------------------------------------------------------
  // STRATEGY 2: Apify Scraper (For external posts)
  // -------------------------------------------------------------
  if (apifyClient) {
    try {
      console.log(`Fetching via Apify scraper for: ${postUrl}...`);
      const run = await apifyClient.actor('apify/instagram-comment-scraper').call({
        directUrls: [postUrl],
        resultsLimit: commentLimit,
      });

      const dataset = apifyClient.dataset(run.defaultDatasetId);
      const items = [];
      const pageSize = 1000;
      let offset = 0;

      // Read the dataset in pages instead of relying on a single listItems call.
      while (items.length < commentLimit) {
        const requestedPageSize = Math.min(pageSize, commentLimit - items.length);
        const page = await dataset.listItems({ limit: requestedPageSize, offset });
        const pageItems = page.items || [];
        if (pageItems.length === 0) break;

        items.push(...pageItems);
        offset += pageItems.length;
        if (pageItems.length < requestedPageSize) break;
      }

      console.log(`Apify run ${run.id} returned ${items.length} dataset items (requested max: ${commentLimit}).`);

      const normalized = items.slice(0, commentLimit).map((item, index) => ({
        id: item.id || `c_${index}`,
        username: item.ownerUsername || item.username || 'user',
        text: item.text || '',
        timestamp: item.timestamp || new Date().toISOString(),
      })).filter(c => c.text || c.username);

      return res.json({
        success: true,
        provider: 'apify',
        count: normalized.length,
        comments: normalized,
      });
    } catch (apifyErr) {
      console.error('Apify error:', apifyErr.message);
      return res.status(500).json({ error: `Failed to fetch comments from Apify: ${apifyErr.message}` });
    }
  }

  return res.status(400).json({ error: 'No retrieval provider available. Please set Meta or Apify keys.' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});