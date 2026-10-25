export interface ApiRequest {
  method: string;
  /** Path below /api, e.g. "/graph/all". */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}
