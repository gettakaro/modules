import { data, takaro } from '@takaro/helpers';
import { renderTemplate } from './wipeUtils.js';

async function main() {
  const { wipeTypeName, note } = data.eventData;
  const message = renderTemplate(data.module.userConfig.announcementMessage, {
    wipeType: wipeTypeName ?? '',
    note: note ?? '',
  });
  if (!message) {
    return;
  }
  await takaro.gameserver.gameServerControllerSendMessage(data.gameServerId, { message });
}

await main();
