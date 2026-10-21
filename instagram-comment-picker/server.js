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

const apifyClient = process.env.APIFY_TOKEN
  ? new ApifyClient({ token: process.env.APIFY_TOKEN })
  : null;

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

  // Meta Graph API is only suitable for media the authorized professional account can access.
  const metaToken = process.env.META_ACCESS_TOKEN;
  const metaUserId = process.env.META_IG_USER_ID;

  if (metaToken && metaUserId && shortcode) {
    try {
      console.log(`Checking Meta Graph API for shortcode: ${shortcode}...`);
      const mediaRes = await axios.get(
        `https://graph.instagram.com/v26.0/${metaUserId}/media`,
        { params: { fields: 'id,permalink', access_token: metaToken, limit: 100 } }
      );

      const mediaList = mediaRes.data.data || [];
      const targetMedia = mediaList.find(
        media => media.permalink && media.permalink.includes(shortcode)
      );

      if (targetMedia) {
        const allComments = [];
        let nextUrl = `https://graph.instagram.com/v26.0/${targetMedia.id}/comments?fields=id,text,username,timestamp&limit=50&access_token=${metaToken}`;

        while (nextUrl && allComments.length < commentLimit) {
          const commentRes = await axios.get(nextUrl);
          const data = commentRes.data;

          if (Array.isArray(data.data)) {
            data.data.forEach(item => {
              if (allComments.length < commentLimit) {
                allComments.push({
                  id: item.id,
                  username: item.username || 'user',
                  text: item.text || '',
                  timestamp: item.timestamp || null,
                });
              }
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
      }
      console.log('Post not found on authorized Meta account. Using public-post scraper.');
    } catch (metaErr) {
      console.warn('Meta API unavailable for this post; trying public-post scraper:', metaErr.message);
    }
  }

  if (!apifyClient) {
    return res.status(400).json({ error: 'APIFY_TOKEN is not configured.' });
  }

  try {
    // This actor supports pagination beyond the first ~12-15 comment page.
    // Its documented maximum is 1,000 top-level comments per post per run.
    const actorLimit = Math.min(commentLimit, 1000);
    console.log(`Fetching up to ${actorLimit} comments via paginated Apify actor for: ${postUrl}`);

    const run = await apifyClient.actor('herus13/instagram-comment-scraper').call({
      targets: [postUrl],
      max_comments: actorLimit,
      proxyProvider: 'default',
    });

    const dataset = apifyClient.dataset(run.defaultDatasetId);
    const items = [];
    const pageSize = 500;
    let offset = 0;

    while (items.length < actorLimit) {
      const requestedPageSize = Math.min(pageSize, actorLimit - items.length);
      const page = await dataset.listItems({ limit: requestedPageSize, offset });
      const pageItems = page.items || [];
      if (pageItems.length === 0) break;

      items.push(...pageItems);
      offset += pageItems.length;
      if (pageItems.length < requestedPageSize) break;
    }

    const normalized = items.slice(0, actorLimit).map((item, index) => {
      const comment = item.comment || item;
      return {
        id: comment.pk || item.id || `c_${index}`,
        username: comment.owner_username || item.ownerUsername || item.username || 'user',
        text: comment.text || item.text || '',
        timestamp: comment.created_at || item.timestamp || null,
      };
    }).filter(comment => comment.text || comment.username);

    console.log(`Apify run ${run.id} returned ${normalized.length} comments (requested max: ${actorLimit}).`);

    return res.json({
      success: true,
      provider: 'apify',
      count: normalized.length,
      comments: normalized,
      requestedLimit: actorLimit,
      note: normalized.length < actorLimit
        ? 'Instagram or the scraper returned fewer comments than the requested limit.'
        : undefined,
    });
  } catch (apifyErr) {
    console.error('Apify error:', apifyErr.message);
    return res.status(500).json({
      error: `Failed to fetch comments from Apify: ${apifyErr.message}`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
