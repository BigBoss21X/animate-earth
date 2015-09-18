import fs from 'fs';
import path from 'path';
import _ from 'lodash';
import glob from 'glob';
import moment from 'moment';
import sh from 'shelljs';
import assert from 'assert';

// path containing full-sized jpgs
const imgPath = '/Volumes/Galactica/earth/img/full-disk-true-color/high';

// output path for finished video
const outPath = '/Volumes/Galactica/earth/output';

// list of crop coordinates for the different cropped videos we're creating
// format: <WIDTH>x<HEIGHT>+<XOFFSET>+<YOFFSET>
//const cropCoords = ['800x600+2000+200', '800x600+3000+1000'];
//const cropCoords = ['2800x1575+1100+3260']; // australia - too big...
//const cropCoords = ['800x600+2100+4260']; // australia small part

//const cropCoords = ['800x600+1758+427', '1280x720+1758+427', '1920x1080+1558+327']; // japan & korea
//const cropCoords = ['640x480+1958+827']; // japan & korea small part

//const cropCoords = ['1920x1080+1558+327']; // #1 japan & korea
//const cropCoords = ['1920x1080+265+1675']; // #2 thailand, malaysia, singapore, laos, cambodia, vietnam, philippines
const cropCoords = ['1920x1080+1558+327', '1920x1080+265+1675']; // #1 and #2
//const cropCoords = ['400x400+1265+2175', '400x400+2265+2675']; // test crop
//const cropCoords = ['250x250+1265+2175']; // test crop



// expected time between images, in seconds. 10 minutes for himawari-8
const imgInterval = 60 * 10;

// max # of missing frames to try to adjust for via extra interpolation
// gaps > than this number of frames will ne split into separate sessions
const maxFrameGap = 5;

// the speed of the finished video in terms of real world seconds per video second
// ie. (seconds of real time elapsed in images) / (seconds in final video)
//const speed = imgInterval / 1; // 1 second of video per 10 minute image (1fps uninterpolated)

// speed by which to slow down the original video
const speed = 0.666667;
//const speed = 1;


// fps of the intermediate uninterpolated video
// only really matters if you plan to use it as well (ie. for comparison)
const origFPS = 2;

// desired fps of final interpolated video
const finalFPS = 60;

//const speed = 60 * 10;

// max # of sessions to make video from, starting from most recent
const maxSessions = 10;

// get all full-res image paths
const files = sh.ls(`${imgPath}/*.jpg`);
// make dates from the image file names
//const fileMoments = files.map(_.flow(timeStrFromPath, parseTimeStr));
// look for gaps in the dates > the expected interval
//const gaps = findGaps(fileMoments, imgInterval);
// split files into sessions wherever gaps are > maxFrameGap
// mostly happens at night between local days (data source is missing ~8 hrs of data / day)
//const sessions = makeSessions(files, gaps, maxFrameGap);
const sessions = sessionsFromFiles(files, imgInterval, maxFrameGap);
assert(files.length, _.reduce(sessions, (total, session) => total + session.files.length, 0));

//console.log(sessions);

const sessionsToRun = _.takeRight(sessions, maxSessions).reverse();
//console.log(sessionsToRun);

// crop the images
sessionsToRun.forEach((session, i) => {
    const dirName = `${timeStrFromPath(_.first(session.files))}-${timeStrFromPath(_.last(session.files))}`;
    const dirPath = `${outPath}/${dirName}`;
    //sh.rm('-rf', dirPath);
    sh.mkdir(dirPath);

    cropCoords.forEach((cropCoord, j) => {
        const cropDir = `${dirPath}/${cropCoord}`;
        sh.mkdir(cropDir);

        // make cropped images
        const imgDir = `${cropDir}/img`;
        sh.mkdir(imgDir);
        session.files.forEach((file, k) => {
            //if(k > 40) return;
            const croppedPath = `${imgDir}/${timeStrFromPath(file)}.jpg`;
            if(sh.ls(croppedPath).length) return; // don't redo crops
            console.log(`cropping session ${i+1} of ${sessionsToRun.length}, crop ${j+1} of ${cropCoords.length}, ` +
                `file ${k+1} of ${session.files.length}, ${croppedPath}`);
            sh.exec(`convert '${file}' -crop ${cropCoord} '${croppedPath}'`);
        });

        // make video
        const videoDir = `${cropDir}/video`;
        const origVideoPath = `${videoDir}/original-${origFPS}fps-lossless.mp4`;
        sh.mkdir(videoDir);
        if(!sh.ls(origVideoPath).length) {
            console.log(makeVideoCmd(imgDir, origFPS, origVideoPath));
            sh.exec(makeVideoCmd(imgDir, origFPS, origVideoPath));
        }

        //const segments = sessionsFromFiles(session.files, imgInterval, 1);
        //console.log(segments);

        //session.files = sh.ls(`${imgDir}/*.jpg`);
        const interpVideoPath = `${videoDir}/interpolated-${origFPS}-${finalFPS}fps-${speed}x-lossless.mp4`;
        if(!sh.ls(interpVideoPath).length) {
            const start = new Date();
            const butterflowCmd = makeButterflowCmd(origVideoPath, interpVideoPath, session.files, speed, origFPS, finalFPS);
            console.log(butterflowCmd);
            sh.exec(butterflowCmd);
            console.log('butterflow took ' + moment().diff(start, 'minutes', true) + ' minutes');
        }

        const interpCompressedPath = `${videoDir}/interpolated-${origFPS}-${finalFPS}fps-${speed}x.mp4`;
        if(!sh.ls(interpCompressedPath).length) {
            const start = new Date();
            const compressCmd = `ffmpeg -i ${interpVideoPath} ${interpCompressedPath}`;
            console.log('compressing lossless file...');
            console.log(compressCmd);
            sh.exec(compressCmd);
            console.log('compression took ' + moment().diff(start, 'minutes', true) + ' minutes');
        }
    });
});

function makeVideoCmd(imgDir, fps, videoPath) {
    return `ffmpeg -y -framerate ${origFPS}\ -pattern_type glob -i '${imgDir}/*.jpg'\
            -c:v libx264 -preset ultrafast -qp 0 -r ${origFPS} -pix_fmt yuv420p ${videoPath}`
    //return `ffmpeg -y -framerate ${origFPS}\ -pattern_type glob -i '${imgDir}/*.jpg'\
    //        -c:v libx264 -r ${origFPS} -pix_fmt yuv420p ${videoPath}`
}

function makeButterflowCmd(inPath, outPath, files, speed, inFPS, outFPS){
    const fileMoments = files.map(_.flow(timeStrFromPath, parseTimeStr));
    let last = 0;
    let segments = [];
    for(var i=1; i < fileMoments.length; i++) {
        const minuteDiff = fileMoments[i].diff(fileMoments[i-1], 'minutes');
        if(minuteDiff > 10) {
            //const fd = d => d.format('MM/DD/YY HH:mm');
            //console.log(`skipped ${minuteDiff} minutes:\t ${fd(fileMoments[i-1])} to ${fd(fileMoments[i])}`);
            const skippedFrames = Math.round(minuteDiff / 10);
            const adjustedSpd = speed * (1 / skippedFrames);
            segments.push(`a=${(last)/inFPS},b=${(i)/inFPS},spd=${speed}:`);
            segments.push(`a=${(i)/inFPS},b=${(i+1)/inFPS},spd=${adjustedSpd}:`);
            last = i+1;
        }
    }
    if(last > 0 && last < fileMoments.length - 1)
        segments.push(`a=${last/inFPS},b=end,spd=${speed}`);
    if(!segments.length)
        segments.push(`full,spd=${speed}`);

    //return [`butterflow -l -r ${outFPS} -o ${outPath} -s `].concat(segments).concat(` ${inPath}`).join('');
    return [`butterflow -l -v --no-preview -r ${outFPS} -o ${outPath} -s `].concat(segments).concat(` ${inPath}`).join('');
}

function timeStrFromPath(path) {
    return _.first(_.last(path.split('_')).split('.'));
}
function parseTimeStr(timeStr) {
    // closest time zone is Cairns, Australia - UTC+10
    return moment.utc(timeStr, 'YYYYMMDDHHmmSS').utcOffset(10);
}
function niceDate(d) { return d.format('MM/DD/YY HH:mm'); }

function findGaps(moments, expectedInterval) {
    let gaps = [];
    for(var i=1; i < moments.length; i++) {
        const dSeconds = moments[i].diff(moments[i-1], 'seconds');
        if(dSeconds > expectedInterval) {
            const skipped = Math.round(dSeconds / expectedInterval);
            gaps.push({i: i-1, skipped});
        }
    }
    return gaps;
}

function makeSessions(files, gaps, maxGap) {
    // whenever time gaps between files > allowed max, split into separate sessions
    const sessionEndIndices = _(gaps)
        .filter(gap => gap.skipped > maxGap).pluck('i').value()
        .concat([files.length - 1]);

    return sessionEndIndices.map((endI, j) => {
        const startI = (j === 0) ? 0 : sessionEndIndices[j-1] + 1;
        return {
            startI, endI,
            files: files.slice(startI, endI+1)
        }
    });
}

function sessionsFromFiles(files, interval, maxGap) {
    const moments = files.map(_.flow(timeStrFromPath, parseTimeStr));
    // look for gaps in the dates > the expected interval
    const gaps = findGaps(moments, interval * maxGap);
    // split files into sessions wherever gaps are > maxFrameGap
    // mostly happens at night between local days (data source is missing ~8 hrs of data / day)
    const sessions = makeSessions(files, gaps, maxGap);
    return sessions;
}
