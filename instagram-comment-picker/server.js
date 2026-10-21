require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));


app.post('/api/fetch-comments', async (req, res) => {
  const { postUrl, limit = 10000 } = req.body;
  const parsedLimit = Number.parseInt(limit, 10);
  const commentLimit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 10000)
    : 10000;

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

  return res.status(503).json({
    success: false,
    code: 'MANUAL_IMPORT_REQUIRED',
    error: 'Automatic fetching is currently unavailable for this Instagram post. Meta API access is generally limited to eligible media for an authorized account. Please import a CSV, JSON, or TXT file containing the comments you are authorized to access.',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
