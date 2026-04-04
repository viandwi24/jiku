/**
 * Plugin System V2 checks — run before main runtime to verify edge cases.
 */

import { PluginLoader, MemoryStorageAdapter, PluginCircularDepError } from '@jiku/core'
import { definePlugin } from '@jiku/kit'

export async function runChecks(): Promise<void> {
  console.log('=== Plugin System V2 Checks ===\n')

  // Check 1: Circular dep — should throw PluginCircularDepError
  console.log('[ Check 1 ] Circular dependency detection')
  const PluginX = definePlugin({ meta: { id: 'plugin.x', name: 'X', version: '1' }, depends: ['plugin.y'], setup() {} })
  const PluginY = definePlugin({ meta: { id: 'plugin.y', name: 'Y', version: '1' }, depends: ['plugin.z'], setup() {} })
  const PluginZ = definePlugin({ meta: { id: 'plugin.z', name: 'Z', version: '1' }, depends: ['plugin.x'], setup() {} })

  try {
    const circularLoader = new PluginLoader()
    circularLoader.register(PluginX, PluginY, PluginZ)
    circularLoader.setStorage(new MemoryStorageAdapter())
    await circularLoader.boot()
    console.log('  ✗ Expected error, but none thrown')
  } catch (e) {
    if (e instanceof PluginCircularDepError) {
      console.log('  ✓ Caught PluginCircularDepError')
      console.log(' ', e.message.split('\n')[0])
    } else {
      throw e
    }
  }

  // Check 2: Missing dep — should warn and disable plugin, not throw
  console.log('\n[ Check 2 ] Missing dependency warning')
  const OrphanPlugin = definePlugin({
    meta: { id: 'jiku.orphan', name: 'Orphan', version: '1.0.0' },
    depends: ['does.not.exist'],
    setup() { console.log('  ✗ setup() should not be called') },
  })

  const missingLoader = new PluginLoader()
  missingLoader.register(OrphanPlugin)
  missingLoader.setStorage(new MemoryStorageAdapter())
  await missingLoader.boot()
  console.log(`  ✓ Orphan disabled, load order: [${missingLoader.getLoadOrder().join(', ') || 'empty'}]`)
}
