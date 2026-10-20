require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { ApifyClient } = require('apify-client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

app.post('/api/fetch-comments', async (req, res) => {
  const { postUrl, limit = 500 } = req.body;

  if (!postUrl || !postUrl.includes('instagram.com')) {
    return res.status(400).json({ error: 'A valid Instagram URL is required.' });
  }

  try {
    // Enable includeReplies so Apify extracts both main comments and replies
    const run = await client.actor('apify/instagram-comment-scraper').call({
      directUrls: [postUrl],
      resultsLimit: parseInt(limit, 10),
      includeReplies: true,
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const normalized = [];
    items.forEach((item, index) => {
      // 1. Add main comment
      if (item.text || item.ownerUsername) {
        normalized.push({
          id: item.id || `c_${index}`,
          username: item.ownerUsername || item.username || 'user',
          text: item.text || '',
          timestamp: item.timestamp,
        });
      }

      // 2. Unpack and add all nested replies so everyone is included
      if (item.replies && Array.isArray(item.replies)) {
        item.replies.forEach((rep, rIndex) => {
          normalized.push({
            id: rep.id || `reply_${index}_${rIndex}`,
            username: rep.ownerUsername || rep.username || 'user',
            text: rep.text || '',
            timestamp: rep.timestamp,
          });
        });
      }
    });

    res.json({
      success: true,
      mode: 'live',
      count: normalized.length,
      comments: normalized,
    });
  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Failed to extract comments from Instagram.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});