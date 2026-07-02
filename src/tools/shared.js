import { z } from 'zod';

export const connOpt = z.string().optional().describe('Connection alias. Omit to use default.');

export const userIdOpt = z.string().optional().describe(
  'SF userId to act as for this call. Must already be registered for the connection (see sf_connect action:"add_user"). Omit to use the connection\'s default userId.'
);
