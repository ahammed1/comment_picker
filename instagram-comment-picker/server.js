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
    // Uses API Dojo's scraper which bypasses the 15-comment free cap
    const run = await client.actor('apidojo/instagram-comments-scraper-api').call({
      postUrls: [postUrl],
      resultsPerPost: parseInt(limit, 10),
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const normalized = items.map((item, index) => ({
      id: item.id || item.commentId || `c_${index}`,
      username: item.ownerUsername || (item.user && item.user.username) || item.username || 'user',
      text: item.text || item.commentText || '',
      timestamp: item.timestamp || item.createdAt || new Date().toISOString(),
    })).filter(c => c.text || c.username);

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