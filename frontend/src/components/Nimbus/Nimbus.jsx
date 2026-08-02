import './Nimbus.css';

export default function Nimbus() {
  return (
    <div className="nimbus-page s88x-hero">

      <p className="nimbus-eyebrow">Industrial Process Automation</p>
      <h1 className="nimbus-h1">
        Configure complex PCS7 hierarchies<br />
        in minutes, not months.
      </h1>

      <div className="nimbus-grid">

        <div className="nimbus-card nimbus-card-white nimbus-card-intro">
          <div>
            <p className="nimbus-eyebrow-label">At a Glance</p>
            <p className="nimbus-lede">From hardware to XML in one unified workflow.</p>
            <p>S88X streamlines the entire PCS7 configuration process—import hardware, define hierarchies, map control modules, and generate production-ready XML without manual scripting.</p>
          </div>
          <div className="nimbus-intro-actions">
            <button className="nimbus-btn nimbus-btn-cream" onClick={() => window.scrollTo(0, 0)}>Back to top</button>
            <button className="nimbus-btn nimbus-btn-jade" onClick={() => window.scrollTo(0, 0)}>Start project</button>
          </div>
        </div>

        <div className="nimbus-card nimbus-card-emerald">
          <div>
            <h3 className="nimbus-card-title-light">Hardware Import</h3>
            <p className="nimbus-card-body-light">Upload your baseline CFG files and automatically detect IO addresses, device configurations, and hardware structure. Zero manual entry errors.</p>
          </div>
          <button className="nimbus-btn nimbus-btn-ghost-light nimbus-btn-sm" style={{ alignSelf: 'flex-start' }}>
            Learn more
          </button>
        </div>

        <div className="nimbus-card nimbus-card-white nimbus-card-precision">
          <h3 className="nimbus-card-title-dark">Intelligent Hierarchy</h3>
          <p className="nimbus-card-body-dark">Build your S88/ISA-88 hierarchy visually with drag-and-drop structure definition. Auto-generate unit instances from your template library.</p>
        </div>

        <div className="nimbus-card nimbus-card-slate">
          <div className="nimbus-sheen"></div>
          <div>
            <h3 className="nimbus-card-title-light">Smart Mapping</h3>
            <p className="nimbus-card-body-light">Automatically map hardware signals to control module parameters. Review conflicts, adjust assignments, and validate before generation—all in a clean, intuitive interface.</p>
          </div>
          <div className="nimbus-dot-orb"></div>
        </div>

        <div className="nimbus-card nimbus-card-white nimbus-card-detail">
          <h3 className="nimbus-card-title-dark">Real-time Validation</h3>
          <p className="nimbus-card-body-dark">See warnings and errors instantly as you configure. No surprises during generation or commissioning.</p>
        </div>

        <div className="nimbus-card nimbus-card-white nimbus-card-battery">
          <h3 className="nimbus-card-title-dark">Production-Ready XML</h3>
          <p className="nimbus-card-body-dark">Generate fully compliant PCS7 XML ready for deployment. All addresses, modules, and connections validated automatically.</p>
        </div>

        <div className="nimbus-card-bottom-row">
          <div className="nimbus-card nimbus-card-white nimbus-card-flat">
            <h3 className="nimbus-card-title-dark">Version Control</h3>
            <p className="nimbus-card-body-dark">Save and restore project snapshots. Compare configurations across hardware revisions.</p>
          </div>
          <div className="nimbus-card nimbus-card-white nimbus-card-flat">
            <h3 className="nimbus-card-title-dark">Reusable Templates</h3>
            <p className="nimbus-card-body-dark">Create once, use everywhere. Share composite CM types and unit patterns across all projects.</p>
          </div>
        </div>

      </div>

      <div className="nimbus-blobs s88x-blobs" aria-hidden="true">
        <div className="nimbus-blob nimbus-blob-emerald"></div>
        <div className="nimbus-blob nimbus-blob-slate"></div>
      </div>

    </div>
  );
}
