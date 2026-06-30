import { z } from 'zod';

export const downloadTaskAdditionalSchema = z
  .array(z.enum(['detail', 'transfer', 'file']))
  .default(['detail', 'transfer']);

export const downloadTaskIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(100)
  .describe('Download Station task IDs.');

export const downloadTaskStatusSchema = z.enum([
  'waiting',
  'downloading',
  'paused',
  'finishing',
  'finished',
  'hash_checking',
  'seeding',
  'filehosting',
  'extracting',
  'error',
]);
