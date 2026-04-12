import { defineMountable, PluginSection, PluginCard } from '@jiku/kit/ui'
import type { StudioComponentProps } from '@jiku-plugin/studio'

function Settings({ ctx }: StudioComponentProps) {
  return (
    <PluginSection
      title="Analytics"
      description="Configuration for the Analytics demo plugin."
    >
      <PluginCard>
        <div className="text-xs text-muted-foreground">Plugin</div>
        <div className="mt-1 font-mono text-sm">
          {ctx.plugin.id} v{ctx.plugin.version}
        </div>
      </PluginCard>
    </PluginSection>
  )
}

export default defineMountable(Settings)
