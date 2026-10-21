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

  const brightDataToken = process.env.BRIGHTDATA_API_KEY;
  if (!brightDataToken) {
    return res.status(503).json({
      success: false,
      code: 'BRIGHTDATA_TOKEN_MISSING',
      error: 'Automatic fetching is not configured yet. Add BRIGHTDATA_API_KEY in Render Environment, then redeploy. You can still import a CSV, JSON, or TXT comments file.',
    });
  }

  try {
    console.log(`Fetching up to ${commentLimit} comments via Bright Data for: ${postUrl}`);

    // Bright Data's Instagram Comments dataset. One returned record represents a comment.
    const triggerRes = await axios.post(
      'https://api.brightdata.com/datasets/v3/trigger',
      [{ url: postUrl }],
      {
        params: {
          dataset_id: 'gd_ltppn085pokosxh13',
          format: 'json',
          uncompressed_webhook: 'true',
        },
        headers: {
          Authorization: `Bearer ${brightDataToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const snapshotId = triggerRes.data?.snapshot_id || triggerRes.data?.snapshotId || triggerRes.data?.id;
    let resultRows = Array.isArray(triggerRes.data) ? triggerRes.data : null;

    // Large collections run asynchronously. Poll for completion before downloading the snapshot.
    if (!resultRows && snapshotId) {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const progressRes = await axios.get(
          `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
          {
            headers: { Authorization: `Bearer ${brightDataToken}` },
            timeout: 20000,
          }
        );
        const status = String(progressRes.data?.status || '').toLowerCase();
        if (status === 'ready' || status === 'completed') {
          ready = true;
          break;
        }
        if (status === 'failed' || status === 'error') {
          throw new Error(progressRes.data?.error || `Bright Data collection status: ${status}`);
        }
      }

      if (!ready) {
        throw new Error('Bright Data collection is taking longer than expected. Please try again shortly.');
      }

      const snapshotRes = await axios.get(
        `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}`,
        {
          params: { format: 'json' },
          headers: { Authorization: `Bearer ${brightDataToken}` },
          timeout: 60000,
        }
      );
      resultRows = Array.isArray(snapshotRes.data)
        ? snapshotRes.data
        : (snapshotRes.data?.data || snapshotRes.data?.items || []);
    }

    if (!Array.isArray(resultRows)) {
      throw new Error('Bright Data returned an unexpected response. Check the dataset configuration in your Bright Data account.');
    }

    const normalized = resultRows.slice(0, commentLimit).map((item, index) => ({
      id: item.comment_id || item.id || item.db_source || `brightdata_${index}`,
      username: String(item.comment_user || item.username || item.author_username || item.ownerUsername || 'user').replace(/^@/, ''),
      text: String(item.comment || item.text || item.comment_text || ''),
      timestamp: item.comment_date || item.timestamp || item.created_at || null,
    })).filter(comment => comment.text.trim());

    console.log(`Bright Data returned ${normalized.length} comments (requested max: ${commentLimit}).`);

    return res.json({
      success: true,
      provider: 'bright_data',
      count: normalized.length,
      comments: normalized,
      requestedLimit: commentLimit,
      note: normalized.length < commentLimit
        ? 'Bright Data returned fewer comments than requested. Check the post visibility and your remaining free allowance.'
        : undefined,
    });
  } catch (providerErr) {
    const message = String(providerErr.response?.data?.message || providerErr.response?.data?.error || providerErr.message || 'Unknown Bright Data error');
    const status = providerErr.response?.status;
    console.error('Bright Data error:', status || '', message);

    return res.status(502).json({
      success: false,
      code: 'BRIGHTDATA_FETCH_FAILED',
      error: `Bright Data could not fetch comments: ${message}. Check that BRIGHTDATA_API_KEY is valid and that the Instagram Comments dataset is enabled in your Bright Data account. You can also import a CSV/JSON/TXT file.`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
