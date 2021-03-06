import React, { Component } from 'react';
import ReactInterval from 'react-interval';
import * as localForage from 'localforage';

import * as FetchAPI from '../utils/fetch_data';
import { PENDING, LOADING } from '../settings';
import { arrayToMap, csetWithCcovData, mapToArray } from '../utils/data';

import bzIcon from '../static/bugzilla.png';

const CACHETIME = 86400; // 24 hours to seconds
const MSTOS = 1000; // ms to s conversion

const ChangesetInfo = ({ changeset }) => {
  const { author, desc, hidden, bzUrl, node, summary, summaryClassName } = changeset;
  const hgUrl = changeset.coverage.hgRev;
  const handleClick = (e) => {
    if (e.target.tagName.toLowerCase() === 'td') {
      window.open(`/#/changeset/${node}`, '_blank');
    } else {
      e.stopPropagation();
    }
  };
  // XXX: For desc display only the first line
  return (
    <tr className={(hidden) ? 'hidden-changeset' : 'changeset'} onClick={e => handleClick(e)}>
      <td className="changeset-author">{author.substring(0, 22)}</td>
      <td className="changeset-hg">
        {(hgUrl) ?
          <a href={hgUrl} target="_blank">{node.substring(0, 12)}</a>
          : <span>{node.substring(0, 12)}</span>}
      </td>
      <td className="changeset-description">
        {desc.substring(0, 40).padEnd(40)}
        {(bzUrl) ?
          <a href={bzUrl} target="_blank"><img className="bzIcon" src={bzIcon} alt="bugzilla icon" /></a>
          : undefined}
      </td>
      <td className={`changeset-summary ${summaryClassName}`}>{summary}</td>
    </tr>
  );
};

const ChangesetsViewer = ({ changesets }) => (
  (changesets.length > 0) ?
    (<table className="changeset-viewer">
      <tbody>
        <tr>
          <th>Author</th>
          <th>Changeset</th>
          <th>Description</th>
          <th>Coverage summary</th>
        </tr>
        {Object.keys(changesets).map(node => (
          <ChangesetInfo
            key={node}
            changeset={changesets[node]}
          />
        ))}
      </tbody>
    </table>) : (<h3 className="loading">{LOADING}</h3>)
);

const PollingStatus = ({ pollingEnabled }) => (
  (pollingEnabled) ?
    (<div className="polling-status"> {pollingEnabled}
      Some changesets are still being processed and we are actively
      polling them until we get a result.
    </div>) : (null)
);

// Return list of changesets
const pushesToCsets = async (pushes, hiddenDefault) => {
  const ignore = ({ desc, author }) => {
    if (
      (author.includes('ffxbld')) ||
      (desc.includes('a=merge') && desc.includes('r=merge')) ||
      (desc.includes('erge') && (desc.includes('to'))) ||
      (desc.includes('ack out')) ||
      (desc.includes('acked out'))) {
      return true;
    }

    return false;
  };
  const filteredCsets = [];
  Object.keys(pushes).reverse().forEach((id) => {
    // Re-order csets and filter out those we don't want
    const csets = pushes[id].changesets.reverse().filter(c => !ignore(c));
    const lenCsets = csets.length;

    if (lenCsets >= 1) {
      csets.forEach((cset) => {
        const bzUrlRegex = /^bug\s*(\d*)/i;
        const bzUrlMatch = bzUrlRegex.exec(cset.desc);
        const bzUrl = bzUrlMatch ? (`http://bugzilla.mozilla.org/show_bug.cgi?id=${bzUrlMatch[1]}`) : null;
        const newCset = {
          pushId: id,
          hidden: hiddenDefault,
          bzUrl,
          linkify: false,
          ...cset,
        };
        filteredCsets.push(newCset);
      });
    }
  });
  // Separating into two blocks makes it easier to code
  const newCsets = await Promise.all(filteredCsets
    .map(async cset => csetWithCcovData(cset)));
  return newCsets;
};

export default class ChangesetsViewerContainer extends Component {
  constructor(props) {
    super(props);
    this.state = {
      changesets: {},
      pollingEnabled: false, // We don't start polling until we're ready
      errorMessage: '',
      hideCsetsWithNoCoverage: true,
      timeout: 30000, // How often we poll for csets w/o coverage status
    };
  }

  async componentDidMount() {
    const { repoName } = this.props;
    const { hideCsetsWithNoCoverage } = this.state;

    const currTime = (new Date()).getTime() / MSTOS;
    localForage.getItem('cachedTime').then((cachedTime) => {
      if (cachedTime && (currTime - cachedTime) < CACHETIME) {
        console.log('Retrieving cached changesets.');
        localForage.getItem('changesets').then((result) => {
          if (!result) {
            this.fetchPushes(repoName, hideCsetsWithNoCoverage);
          } else {
            console.log(`Retrieved cached changesets. We have ${result.length} changesets.`);
            this.setState({
              changesets: arrayToMap(result),
              pollingEnabled: result.filter(c => c.summary === PENDING).length > 0,
            });
          }
        });
      } else {
        this.fetchPushes(repoName, hideCsetsWithNoCoverage);
      }
    });
  }

  async fetchPushes(repoName, hideCsetsWithNoCoverage) {
    try {
      // Fetch last 10 pushes
      const text = await (await FetchAPI.getJsonPushes(repoName)).json();
      const csets = await pushesToCsets(text.pushes, hideCsetsWithNoCoverage);
      console.log(`We have ${csets.length} changesets.`);
      this.setState({
        changesets: arrayToMap(csets),
        pollingEnabled: csets.filter(c => c.summary === PENDING).length > 0,
      });
      localForage.setItem('changesets', csets);
      localForage.setItem('cachedTime', (new Date()).getTime() / MSTOS);
    } catch (error) {
      console.log(error);
      this.setState({
        changesets: {},
        pollingEnabled: false,
        errorMessage: 'We have failed to fetch coverage data.',
      });
    }
  }

  // We poll on an interval for coverage for csets without it
  async pollPending(changesets) {
    console.log('Determine if we need to poll csets w/o coverage data...');
    try {
      let newCsets = mapToArray(changesets);
      newCsets = await Promise.all(
        newCsets.map((c) => {
          if (c.summary !== PENDING) {
            return c;
          }
          return csetWithCcovData(c);
        }));
      const count = newCsets.filter(c => c.summary === PENDING).length;
      const csetsMap = arrayToMap(newCsets);
      if (count === 0) {
        console.log('No more polling required.');
        this.setState({ changesets: csetsMap, pollingEnabled: false });
      } else {
        this.setState({ changesets: csetsMap });
      }
    } catch (e) {
      this.setState({ pollingEnabled: false });
    }
  }

  render() {
    const { changesets, pollingEnabled, errorMessage, timeout } = this.state;
    if (errorMessage) {
      return (<div className="error-message">{errorMessage}</div>);
    }
    const viewableCsets = mapToArray(changesets).filter(c => c.hidden === false);

    return (
      <div>
        {pollingEnabled && (
          <div>
            <ReactInterval
              timeout={timeout}
              enabled={pollingEnabled}
              callback={() => this.pollPending(changesets)}
            />
            <PollingStatus
              pollingEnabled={pollingEnabled}
            />
          </div>
        )}
        <ChangesetsViewer
          changesets={viewableCsets}
        />
      </div>
    );
  }
}
