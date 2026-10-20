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

// Apify Client
const client = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

app.post('/api/fetch-comments', async (req, res) => {
  const { postUrl, limit = 200 } = req.body;

  if (!postUrl || !postUrl.includes('instagram.com')) {
    return res.status(400).json({ error: 'A valid Instagram URL is required.' });
  }

  // Fallback if no token is configured
  if (!process.env.APIFY_TOKEN) {
    return res.json({
      success: true,
      mode: 'demo',
      comments: [
        { id: 'c1', username: 'alex_adventures', text: 'OMG I need this! @sarah_travels check this giveaway out 🔥 #giveaway' },
        { id: 'c2', username: 'maria.design', text: 'Love your work! Tagging my bestie @claire_art #giveaway' },
        { id: 'c3', username: 'fitness_john', text: 'Count me in! Hope I win this one 🙏' },
        { id: 'c4', username: 'elena_cooks', text: 'Amazing! @mike_foodie @jenny_eats you guys have to enter too!' },
        { id: 'c5', username: 'dev_rohit', text: 'Pick me please! @rahul_tech this looks insane #giveaway' },
        { id: 'c6', username: 'sophie_style', text: 'Obsessed! @emma_fashion let us win please' },
        { id: 'c7', username: 'alex_adventures', text: 'Second entry just in case! @sarah_travels' },
        { id: 'c8', username: 'kavita_m', text: 'Fingers crossed! 🤞 @priya_designs' }
      ]
    });
  }

  try {
    // Calls Apify Instagram Comment Scraper Actor
    const run = await client.actor('apify/instagram-comment-scraper').call({
      directUrls: [postUrl],
      resultsLimit: parseInt(limit, 10),
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const normalized = items.map((item, index) => ({
      id: item.id || `c_${index}`,
      username: item.ownerUsername || item.username || 'user',
      text: item.text || '',
      timestamp: item.timestamp,
    }));

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