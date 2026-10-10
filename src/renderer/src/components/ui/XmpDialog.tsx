import { useState } from 'react'
import type { XmpApi, XmpProposal, XmpReview } from '../../../../shared/xmp'
import { useDialogFocus } from './useDialogFocus'

interface Props { open: boolean; onClose: () => void; api: XmpApi }
const names: Record<string, string> = {
  Exposure2012: '노출 (EV)', Contrast2012: '대비', Highlights2012: '밝은 부분',
  Shadows2012: '어두운 부분', Whites2012: '흰색', Blacks2012: '검은색',
  Temperature: '색온도 (K)', Tint: '색조', Sharpness: '선밝기',
  Clarity2012: '부분 대비', Texture: '질감', Dehaze: '안개 제거',
  Vibrance: '색 생동감', Saturation: '채도', GrainAmount: '필름 입자',
  ColorGradeShadowHue: '어두운 부분 색상', ColorGradeShadowSat: '어두운 부분 채도',
  ColorGradeShadowLum: '어두운 부분 밝기', ColorGradeMidtoneHue: '중간 밝기 색상',
  ColorGradeMidtoneSat: '중간 밝기 채도', ColorGradeMidtoneLum: '중간 밝기 밝기',
  ColorGradeHighlightHue: '밝은 부분 색상', ColorGradeHighlightSat: '밝은 부분 채도',
  ColorGradeHighlightLum: '밝은 부분 밝기', ColorGradeBlending: '색상 혼합'
}

export function XmpDialog({ open, onClose, api }: Props): JSX.Element | null {
  const [review, setReview] = useState<XmpReview | null>(null)
  const [fieldKey, setFieldKey] = useState('')
  const [value, setValue] = useState('')
  const [proposal, setProposal] = useState<XmpProposal | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const close = (): void => { if (!busy) onClose() }
  const ref = useDialogFocus(open, close)
  if (!open) return null
  const field = review?.fields.find((entry) => entry.key === fieldKey)
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  function adopt(next: XmpReview): void {
    setReview(next); setProposal(null)
    const selected = next.fields.find((entry) => entry.key === fieldKey) ?? next.fields[0]
    setFieldKey(selected?.key ?? ''); setValue(selected ? String(selected.value) : '')
  }
  const button = 'px-3 py-2 border border-[#343434] rounded-md disabled:opacity-40'
  return <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/50">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="xmp-title" tabIndex={-1}
      className="w-[720px] max-w-full max-h-[calc(100vh-48px)] overflow-y-auto rounded-[10px] border border-[#343434] bg-[#262626] p-5 text-[#eee] text-[13px]">
      <div className="flex items-center justify-between mb-4"><h2 id="xmp-title" className="text-[16px] font-semibold">사진 프리셋 XMP 검토</h2>
        <button type="button" onClick={close} disabled={busy} className={button}>닫기</button></div>
      <p className="text-[#a3a3a3] mb-4">선택한 XMP의 지원 항목을 검토하고, 보정값의 변경 내용을 확인한 뒤 저장합니다. Lightroom과 Luxinus의 보정 결과는 다를 수 있습니다.</p>
      <button type="button" disabled={busy} className={button} onClick={() => void run(async () => {
        const next = await api.open()
        if (next) { adopt(next); setOperationId(null) }
      })}>XMP 파일 선택</button>
      {review && <>
        <h3 className="text-[14px] font-semibold mt-5 break-all">{review.fileName}</h3>
        <p className="text-[12px] text-[#a3a3a3] mt-1">지원하는 보정값 {review.fields.length}개 · 나머지 원문 보존</p>
        {review.ignored.length > 0 && <details className="mt-3 border-y border-[#343434] py-3"><summary className="cursor-pointer">직접 수정할 수 없는 항목 {review.ignored.length}개</summary>
          <p className="mt-2 text-[12px] break-words">{review.ignored.join(', ')}</p></details>}
        {review.fields.length === 0 ? <p className="mt-4">이 문서는 직접 수정할 수 있는 숫자 속성이 없습니다. RDF 배열·중첩 보정·타사 확장은 원문으로 보존됩니다.</p> :
          <div className="flex flex-wrap items-end gap-3 mt-4">
            <label className="flex-1 min-w-[200px]">수정 항목<select aria-label="XMP 수정 항목" value={fieldKey} disabled={busy || !!proposal}
              onChange={(event) => { const next = review.fields.find((entry) => entry.key === event.target.value)!; setFieldKey(next.key); setValue(String(next.value)) }}
              className="block mt-1 w-full bg-[#1c1c1c] border border-[#343434] rounded-md p-2">
              {review.fields.map((entry) => <option key={entry.key} value={entry.key}>{names[entry.key] ?? entry.key}</option>)}
            </select></label>
            <label className="w-[140px]">변경 값<input type="number" aria-label="XMP 변경 값" disabled={busy || !!proposal} value={value} min={field?.min} max={field?.max} step="any"
              onChange={(event) => setValue(event.target.value)} className="block mt-1 w-full bg-[#1c1c1c] border border-[#343434] rounded-md p-2 tabular-nums" /></label>
            <button type="button" className={button} disabled={busy || !!proposal || !field || !value.trim() || Number(value) === field.value}
              onClick={() => void run(async () => setProposal(await api.propose(review.documentId, { [fieldKey]: Number(value) })))}>변경 미리보기</button>
          </div>}
        {field && <p className="text-[12px] text-[#a3a3a3] mt-2">{field.key} · 현재 {field.value} · 허용 범위 {field.min}~{field.max}</p>}
      </>}
      {proposal && <div className="mt-5 border-t border-[#343434] pt-4">
        <h3 className="font-semibold">저장 전 변경 확인</h3>
        <table className="w-full mt-3 text-left tabular-nums"><thead><tr className="text-[#a3a3a3]"><th className="py-2">항목</th><th>현재</th><th>변경</th></tr></thead>
          <tbody>{proposal.changes.map((change) => <tr key={change.key} className="border-t border-[#343434]"><td className="py-2">{names[change.key] ?? change.key}</td><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table>
        <details className="mt-3"><summary className="cursor-pointer text-[#a3a3a3]">XMP 원문 비교</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">{[['변경 전', proposal.before], ['변경 후', proposal.after]].map(([label, source]) => <div key={label}>
            <p className="mb-1">{label}</p><pre className="max-h-[200px] overflow-auto bg-[#1c1c1c] p-2 text-[12px] whitespace-pre-wrap break-all">{source.slice(0, 30000)}</pre>
            {source.length > 30000 && <p className="text-[12px] text-[#a3a3a3]">원문이 길어 처음 30,000자만 표시합니다. 위 표가 전체 변경 항목입니다.</p>}
          </div>)}</div>
        </details>
        <p className="text-[12px] text-[#a3a3a3] mt-3">저장 시 원문 변경 여부를 다시 확인합니다. 이 XMP 파일 1개에만 적용하며, 변경 전 원문을 로컬 작업 기록에 보관합니다.</p>
        <div className="flex gap-2 mt-3"><button type="button" className="px-3 py-2 rounded-md bg-[#b7a8f7] text-[#151515] disabled:opacity-40" disabled={busy}
          onClick={() => void run(async () => { const result = await api.apply(proposal.proposalId); adopt(result.review); setOperationId(result.operationId); setNotice('XMP 저장 완료. 프리셋으로 사용하려면 프리셋 패널에서 다시 가져오세요.') })}>이 XMP 1개에 적용</button>
          <button type="button" className={button} disabled={busy} onClick={() => setProposal(null)}>수정안 취소</button></div>
      </div>}
      {operationId && <button type="button" className={`${button} mt-4`} disabled={busy || !!proposal} onClick={() => void run(async () => {
        adopt(await api.undo(operationId)); setOperationId(null); setNotice('직전 XMP 변경을 되돌렸습니다.')
      })}>직전 XMP 변경 되돌리기</button>}
      {busy && <p role="status" className="mt-4">파일 작업 처리 중…</p>}
      {notice && <p role="status" className="mt-4">{notice}</p>}
      {error && <p role="alert" className="mt-4 whitespace-pre-wrap">{error}</p>}
    </div>
  </div>
}
