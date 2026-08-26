export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiMeta {
  requestId: string;
  generatedAt?: string;
  pagination?: PaginationMeta;
  [key: string]: unknown;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorEnvelope {
  data: null;
  meta: ApiMeta;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
