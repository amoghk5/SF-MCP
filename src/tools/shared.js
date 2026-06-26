import { z } from 'zod';

export const connOpt = z.string().optional().describe('Connection alias. Omit to use default.');
