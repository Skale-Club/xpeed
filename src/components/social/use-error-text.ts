import { useTranslation } from 'react-i18next';
import { socialErrorKey, type SocialErrorKey } from '@/lib/sim/social-client';

/** The sentence for an error of the social side, in the person's language. Never names a table, an account or an e-mail. */
export function useErrorText(): (error: unknown) => string {
  const { t } = useTranslation();
  return (error) => {
    const texts: Record<SocialErrorKey, string> = {
      generic: t('social.errors.generic', 'That did not work. Try again in a moment.'),
      offline: t('social.errors.offline', 'The server could not be reached. Check your connection and try again.'),
      signedOut: t('social.errors.signedOut', 'You are signed out. Sign in again to continue.'),
      unavailable: t('social.errors.unavailable', 'The server is not answering right now. Try again in a moment.'),
      invalid_handle: t('social.errors.invalid_handle', 'A handle has 3 to 24 letters, digits or underscores (a to z, 0 to 9, _).'),
      reserved_handle: t('social.errors.reserved_handle', 'This handle is reserved. Choose another one.'),
      handle_taken: t('social.errors.handle_taken', 'This handle is taken. Choose another one.'),
      handle_change_limit: t('social.errors.handle_change_limit', 'You changed your handle 3 times in the last 30 days. Try again later.'),
      invalid_display_name: t('social.errors.invalid_display_name', 'A name has 1 to 40 characters, and cannot look like an e-mail address.'),
      invalid_visibility: t('social.errors.invalid_visibility', 'Choose who can see your profile.'),
      handle_not_found: t('social.errors.handle_not_found', 'No driver can be added with this handle.'),
      profile_not_found: t('social.errors.profile_not_found', 'Driver not found.'),
      request_not_found: t('social.errors.request_not_found', 'This request is not there any more.'),
      friend_not_found: t('social.errors.friend_not_found', 'This person is not in your list any more.'),
      share_not_found: t('social.errors.share_not_found', 'This link is not there any more.'),
      target_not_found: t('social.errors.target_not_found', 'This cannot be reported: it is not available any more.'),
      report_not_found: t('social.errors.report_not_found', 'This report is not there any more.'),
      lap_not_found: t('social.errors.lap_not_found', 'This lap is not in your account any more.'),
      session_not_found: t('social.errors.session_not_found', 'This session is not in your account any more.'),
      already_friends: t('social.errors.already_friends', 'You are already friends.'),
      already_requested: t('social.errors.already_requested', 'You already sent a request to this driver.'),
      blocked: t('social.errors.blocked', 'You blocked this driver. Unblock them first.'),
      already_reported: t('social.errors.already_reported', 'You already reported this and it is still being reviewed.'),
      already_decided: t('social.errors.already_decided', 'This report was already decided.'),
      friend_limit: t('social.errors.friend_limit', 'You (or they) reached the limit of 200 friends.'),
      pending_limit: t('social.errors.pending_limit', 'You have 50 requests waiting. Wait for answers before sending more.'),
      share_limit: t('social.errors.share_limit', 'You have 100 active links. Revoke some before making more.'),
      too_many_open_reports: t('social.errors.too_many_open_reports', 'You have 50 reports waiting for review. Try again when some are decided.'),
      too_many_requests: t('social.errors.too_many_requests', 'Too many tries in a short time. Wait a little and try again.'),
      invalid_target: t('social.errors.invalid_target', 'This cannot be done with yourself.'),
      invalid_details: t('social.errors.invalid_details', 'The details can have up to 300 characters.'),
      invalid_reason: t('social.errors.invalid_reason', 'Choose a reason.'),
      invalid_expires: t('social.errors.invalid_expires', 'Choose when the link stops working.'),
      confirmation_required: t('social.errors.confirmation_required', 'Type the sentence exactly as shown to confirm.'),
      forbidden: t('social.errors.forbidden', 'This is only for moderators.'),
    };
    return texts[socialErrorKey(error)];
  };
}
