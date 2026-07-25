import { Router } from 'express';
import type { AppConfig } from '../../../config/env.js';
import type { WidgetAssets } from './widget-assets.js';

export function createChatGptAppPreviewRouter(
  config: Pick<AppConfig, 'NODE_ENV'>,
  widgetAssets: WidgetAssets,
) {
  const router = Router();

  if (config.NODE_ENV !== 'production') {
    router.get('/', async (_request, response, next) => {
      try {
        response.type('html').send(await widgetAssets.readPreview());
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
