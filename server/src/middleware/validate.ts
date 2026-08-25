import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { ApiError } from '../utils/ApiError';

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

const formatIssues = (error: ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));

/**
 * Parses and REPLACES the request payload with the validated result, so
 * handlers can never accidentally read the raw, unvalidated input.
 */
export const validate =
  (schemas: RequestSchemas) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.validated = req.validated ?? {};
      if (schemas.params) req.validated.params = schemas.params.parse(req.params);
      if (schemas.query) req.validated.query = schemas.query.parse(req.query);
      if (schemas.body) req.validated.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(ApiError.validation('The submitted data is not valid', formatIssues(error)));
        return;
      }
      next(error);
    }
  };

/** Typed accessors so controllers stay free of casts. */
export const body = <T>(req: Request): T => req.validated?.body as T;
export const query = <T>(req: Request): T => req.validated?.query as T;
export const params = <T>(req: Request): T => req.validated?.params as T;
