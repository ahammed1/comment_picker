require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { ApifyClient } = require('apify-client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
    const run = await client.actor('apify/instagram-comment-scraper').call({
      directUrls: [postUrl],
      resultsLimit: parseInt(limit, 10),
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const normalized = items.map((item, index) => ({
      id: item.id || `c_${index}`,
      username: item.ownerUsername || item.username || 'user',
      text: item.text || '',
      timestamp: item.timestamp || new Date().toISOString(),
    })).filter(c => c.text || c.username);

    res.json({
      success: true,
      count: normalized.length,
      comments: normalized,
    });
  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});