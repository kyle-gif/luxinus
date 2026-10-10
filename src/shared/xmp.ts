export interface XmpField {
  key: string
  value: number
  min: number
  max: number
}
export interface XmpReview {
  documentId: string
  fileName: string
  hash: string
  fields: XmpField[]
  mapped: string[]
  ignored: string[]
}
export interface XmpProposal {
  proposalId: string
  fileName: string
  beforeHash: string
  afterHash: string
  changes: { key: string; before: number; after: number }[]
  before: string
  after: string
}
export interface XmpApplyResult {
  operationId: string
  review: XmpReview
}
export interface XmpApi {
  open(): Promise<XmpReview | null>
  propose(documentId: string, patch: Record<string, number>): Promise<XmpProposal>
  apply(proposalId: string): Promise<XmpApplyResult>
  undo(operationId: string): Promise<XmpReview>
}
