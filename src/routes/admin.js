const express = require('express');
const adminController = require('../controllers/adminController');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Public auth pages
router.get('/login', adminController.showLogin);
router.post('/login', adminController.login);
router.post('/logout', adminController.logout);

// Admin-only
router.get('/', requireAdmin, adminController.listUsers);
router.post('/users', requireAdmin, adminController.createUser);
router.post('/users/:id/regenerate-key', requireAdmin, adminController.regenerateKey);
router.post('/users/:id/password', requireAdmin, adminController.setPassword);
router.post('/users/:id/enable', requireAdmin, adminController.enableUser);
router.post('/users/:id/disable', requireAdmin, adminController.disableUser);
router.post('/users/:id/delete', requireAdmin, adminController.deleteUser);

module.exports = router;
