'use strict';

const express = require('express');
const { subscribe } = require('../services/event-bus');

const router = express.Router();

router.get('/sends', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 25_000);

  const unsubscribe = subscribe((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // client gone; cleanup happens in `close`
    }
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

module.exports = router;
