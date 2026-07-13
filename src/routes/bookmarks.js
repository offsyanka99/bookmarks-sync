const express = require('express');
const bookmarkController = require('../controllers/bookmarkController');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// Per-user API key (not the old global API_KEY)
router.use(requireApiKey);

router.get('/', bookmarkController.list);
router.post('/', bookmarkController.create);
router.post('/sync', bookmarkController.sync);
router.get('/export', bookmarkController.exportAll);
router.post('/import', bookmarkController.importAll);

router.get('/:id', bookmarkController.getById);
router.put('/:id', bookmarkController.update);
router.delete('/:id', bookmarkController.remove);

module.exports = router;
