import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { productService } from './products.service';
import type {
  CreateProductInput,
  ListProductsInput,
  PosCatalogInput, PosSearchInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from './products.validators';

type IdParams = { id: Types.ObjectId };
type VariantParams = { id: Types.ObjectId; variantId: Types.ObjectId };

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await productService.list(getContext(req), query<ListProductsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const posCatalog = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await productService.posCatalog(getContext(req), query<PosCatalogInput>(req)));
});

export const posSearch = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await productService.posSearch(getContext(req), query<PosSearchInput>(req)));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  ok(res, await productService.getById(getContext(req), id));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await productService.create(getContext(req), body<CreateProductInput>(req)));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  ok(res, await productService.update(getContext(req), id, body<UpdateProductInput>(req)));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  ok(res, await productService.remove(getContext(req), id));
});

/** Issues a fresh, unused EAN-13 barcode for a variant. */
export const generateBarcode = asyncHandler(async (req: Request, res: Response) => {
  ok(res, { barcode: await productService.generateBarcode(getContext(req)) });
});

export const addVariant = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  created(res, await productService.addVariant(getContext(req), id, body<VariantInput>(req)));
});

export const updateVariant = asyncHandler(async (req: Request, res: Response) => {
  const { id, variantId } = params<VariantParams>(req);
  ok(res, await productService.updateVariant(getContext(req), id, variantId, body<UpdateVariantInput>(req)));
});

export const removeVariant = asyncHandler(async (req: Request, res: Response) => {
  const { id, variantId } = params<VariantParams>(req);
  ok(res, await productService.removeVariant(getContext(req), id, variantId));
});
