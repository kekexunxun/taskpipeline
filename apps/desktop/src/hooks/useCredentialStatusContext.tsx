import { createContext, useContext } from 'react'
import type { CredentialStatusSnapshot } from './useCredentialStatus'

const CredentialStatusContext = createContext<CredentialStatusSnapshot | null>(null)

export const CredentialStatusProvider = CredentialStatusContext.Provider

export function useCredentialStatusContext(): CredentialStatusSnapshot {
  const value = useContext(CredentialStatusContext)
  if (!value) throw new Error('useCredentialStatusContext must be used inside <CredentialStatusProvider>')
  return value
}
