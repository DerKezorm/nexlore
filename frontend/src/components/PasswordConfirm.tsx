/** The second field of every new password (the module's "Repeat password", konten 0.3.7: its label is the field's name),
 * with its own message right below it when the two differ. A `Field` of the shared kit (`vendor/nexui`). */
import { useTranslation } from 'react-i18next'

import { FIELDS } from '../vendor/nexkonten/konten'
import { Field } from '../vendor/nexui'

export function PasswordConfirmField({ value, onChange, mismatch }: { value: string; onChange: (value: string) => void; mismatch: boolean }) {
  const { t } = useTranslation()
  return (
    <Field
      label={t(FIELDS.passwordRepeat.label)}
      type="password"
      name="password_confirm"
      value={value}
      // Both fields "new-password": the password manager fills the same suggestion into both.
      autoComplete="new-password"
      error={mismatch ? t('account.passwordMismatch') : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
