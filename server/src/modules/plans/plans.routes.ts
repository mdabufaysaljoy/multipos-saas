import { Router } from 'express';
import { authenticate, requirePlatformAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './plans.controller';
import { createPlanSchema, planAdminListQuerySchema, planCatalogQuerySchema, updatePlanSchema } from './plans.validators';

const router = Router();

// Pricing is public: a prospective customer must be able to see it.
router.get('/', validate({ query: planCatalogQuerySchema }), controller.listPublic);

router.get('/all', authenticate, requirePlatformAdmin, validate({ query: planAdminListQuerySchema }), controller.listAll);
router.get('/:id/usage', authenticate, requirePlatformAdmin, validate({ params: idParam }), controller.usage);
router.post('/', authenticate, requirePlatformAdmin, validate({ body: createPlanSchema }), controller.create);
router.patch('/:id', authenticate, requirePlatformAdmin, validate({ params: idParam, body: updatePlanSchema }), controller.update);
router.delete('/:id', authenticate, requirePlatformAdmin, validate({ params: idParam }), controller.deactivate);

export default router;
