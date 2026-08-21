import { useEffect, useState } from 'react'
import { Loader2Icon, SaveIcon, Trash2Icon } from 'lucide-react'
import type { CapabilityKey } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MODEL_VENDORS, detectVendor, type ModelVendor } from '@/utils/model-vendors'

export type OpenAIProfile = {
  id?: string
  vendor?: ModelVendor
  baseUrl: string
  model: string
  displayName?: string
  apiKeyConfigured: boolean
  isDefault?: boolean
  /** 用户显式声明的可调参数能力；缺省 = 按 vendor 自动推断。 */
  capabilities?: CapabilityKey[]
}

/** 能力多选项（与 driver 端 capabilitiesForProfile 的自动推断语义对齐）。 */
const CAPABILITY_OPTIONS: { key: CapabilityKey; label: string }[] = [
  { key: 'reasoningEffort', label: '推理力度' },
  { key: 'thinking', label: '思考模式' },
  { key: 'maxOutputTokens', label: '最大输出 Token' }
]

/**
 * OpenAI-Compatible 模型配置弹窗：
 * - 选择厂商（DeepSeek / OpenAI 官方 / 其它兼容端点）自动填充默认 URL；
 * - 填写 URL（Base URL）、API Key、显示名称、Model ID；
 * - 「设为默认」：组内默认 profile（失效 fallback 与系统级 OpenAI 调用取用）；
 * - 「参数能力」：显式声明该模型支持的可调参数（覆盖按 vendor 的自动推断）；
 * - 支持新增/编辑两种模式，编辑时若 API Key 为空则保留已有值。
 */
export function OpenAIProfileDialog({
  open,
  onOpenChange,
  initial,
  mode,
  onSaved,
  onDeleted,
  onError
}: {
  open: boolean
  onOpenChange(open: boolean): void
  initial?: OpenAIProfile
  mode: 'create' | 'edit'
  onSaved(profile: {
    id?: string
    vendor?: ModelVendor
    baseUrl: string
    model: string
    displayName?: string
    apiKey: string | undefined
    isDefault: boolean
    capabilities?: CapabilityKey[]
  }): void
  onDeleted?(): void
  onError?(reason: unknown): void
}) {
  const [baseUrl, setBaseUrl] = useState('')
  const [vendor, setVendor] = useState<ModelVendor>('openai-compatible')
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [manualCapabilities, setManualCapabilities] = useState(false)
  const [capabilities, setCapabilities] = useState<CapabilityKey[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (!open) return
    setBaseUrl(initial?.baseUrl ?? '')
    setVendor(initial?.vendor ?? detectVendor(initial?.baseUrl))
    setModel(initial?.model ?? '')
    setDisplayName(initial?.displayName ?? '')
    setApiKey(initial?.apiKeyConfigured ? '__configured__' : '')
    setIsDefault(initial?.isDefault ?? false)
    setManualCapabilities(initial?.capabilities !== undefined)
    setCapabilities(initial?.capabilities ?? [])
  }, [open, initial])
  const trimmedBase = baseUrl.trim()
  const trimmedModel = model.trim()
  /** 当前厂商的开箱即用模型列表（空 = 自由填写）。 */
  const vendorModels = MODEL_VENDORS.find((v) => v.id === vendor)?.models ?? []
  const canSave = trimmedBase.length > 0 && trimmedModel.length > 0 && !saving && !deleting
  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const apiKeyValue = apiKey === '__configured__' ? undefined : apiKey
      onSaved({
        id: initial?.id,
        vendor,
        baseUrl: trimmedBase,
        model: trimmedModel,
        displayName: displayName.trim() || undefined,
        apiKey: apiKeyValue,
        isDefault,
        capabilities: manualCapabilities ? capabilities : undefined
      })
    } catch (reason) {
      onError?.(reason)
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    if (!onDeleted) return
    setDeleting(true)
    try {
      onDeleted()
    } catch (reason) {
      onError?.(reason)
    } finally {
      setDeleting(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[min(560px,calc(100vh-64px))] !w-[520px] !max-w-[520px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="space-y-1 border-b px-5 pt-3.5 pb-3">
          <DialogTitle className="text-sm">
            {mode === 'create' ? '新增 OpenAI-Compatible 模型' : '编辑 OpenAI-Compatible 模型'}
          </DialogTitle>
          <DialogDescription>配置兼容 OpenAI API 格式的模型服务，可用于对话与任务执行。</DialogDescription>
        </DialogHeader>
        <div className="thin-scrollbar min-h-0 overflow-y-auto px-5 py-4">
          <FieldGroup className="gap-3">
            <Field label="厂商">
              <Select
                value={vendor}
                disabled={mode === 'edit'}
                onValueChange={(value) => {
                  setVendor(value as ModelVendor)
                  // 切换厂商时自动填充默认 URL（仅当 URL 为空或还是旧厂商默认值时）
                  const def = MODEL_VENDORS.find((v) => v.id === value)?.defaultBaseUrl ?? ''
                  const oldDef = MODEL_VENDORS.find((v) => v.id !== value)?.defaultBaseUrl
                  const trimmed = baseUrl.trim()
                  if (def && (!trimmed || trimmed === oldDef)) setBaseUrl(def)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择厂商" />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_VENDORS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-4 text-muted-foreground">
                官方端点使用专用 SDK（更完整的推理/结构化解析）；未知网关请选「其它兼容端点」。
              </p>
            </Field>
            <Field label="URL">
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://gateway.example.com/v1"
              />
            </Field>
            <Field label="API Key">
              <SecretInput
                aria-label="API Key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxx"
              />
            </Field>
            <Field label="名称">
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="公司自建网关"
              />
            </Field>
            <Field label="使用的模型 (Model)">
              {vendorModels.length > 0 ? (
                <>
                  <Input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="选择或输入模型"
                    list={`model-suggest-${vendor}`}
                  />
                  <datalist id={`model-suggest-${vendor}`}>
                    {vendorModels.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.items.map((option) => (
                          <option key={option} value={option} />
                        ))}
                      </optgroup>
                    ))}
                  </datalist>
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {MODEL_VENDORS.find((v) => v.id === vendor)?.name} 支持开箱即用模型，点击输入框可下拉选择；
                    非对话模型（生成/语音）不适用于对话，请勿选用
                  </p>
                </>
              ) : (
                <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
              )}
            </Field>
            <Field label="设为默认（组内默认 profile）">
              <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            </Field>
            <Field label="参数能力（选择器可调参数）">
              <div className="flex items-center gap-2">
                <Switch checked={manualCapabilities} onCheckedChange={setManualCapabilities} />
                <span className="text-[11px] text-muted-foreground">手动指定（关闭时按厂商自动推断）</span>
              </div>
              {manualCapabilities && (
                <div className="flex flex-wrap gap-3 pt-1">
                  {CAPABILITY_OPTIONS.map((option) => (
                    <label key={option.key} className="flex cursor-pointer items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={capabilities.includes(option.key)}
                        onCheckedChange={(checked) =>
                          setCapabilities((current) =>
                            checked ? [...current, option.key] : current.filter((key) => key !== option.key)
                          )
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              )}
            </Field>
            {trimmedModel && (
              <div className="flex items-center gap-2 rounded-md border bg-card/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">预览</span>
                <Badge variant="outline">{displayName.trim() || 'OpenAI-Compatible'}</Badge>
                <span className="truncate font-mono text-xs text-foreground/80">{trimmedModel}</span>
              </div>
            )}
          </FieldGroup>
        </div>
        <DialogFooter className="border-t px-5 py-2.5">
          {mode === 'edit' && onDeleted && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground hover:text-destructive"
              disabled={deleting || saving}
              onClick={() => void remove()}
            >
              {deleting ? <Loader2Icon className="animate-spin-slow" size={11} /> : <Trash2Icon size={11} />}
              {deleting ? '删除中' : '删除配置'}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SaveIcon size={11} />}
            {saving ? '保存中' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
