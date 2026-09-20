import { useState } from 'react'
import { MnsClient } from './mns-client'

export function useAuth(initial = false): [boolean, (v: boolean) => void] {
  const [authed, setAuthed] = useState(initial)
  return [authed, setAuthed]
}

const client = new MnsClient('acct', 'key')
void client

export default function App() {
  const [authed] = useAuth()
  return <div>{authed ? 'ok' : 'no'}</div>
}
