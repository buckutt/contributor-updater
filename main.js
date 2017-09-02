const axios       = require('axios');
const fs          = require('fs');
const https       = require('https');
const config      = require('./config');

const agent = new https.Agent({
    pfx       : fs.readFileSync(`./${config.certificate.file}`),
    passphrase: config.certificate.password
});

const options = {
    httpsAgent: agent
};

const credentials = {
    data       : config.buckutt.admin.mol,
    password   : config.buckutt.admin.password,
    meanOfLogin: 'etuMail'
};

const notRemoved = encodeURIComponent(JSON.stringify({ field: 'isRemoved', eq: false }));

const embedUsers = encodeURIComponent(JSON.stringify({
    groups: {
        _through: {
            period: true
        }
    }
}));

let token          = '';
let buckuttMembers = [];

axios.post(`https://${config.buckutt.api}/services/login`, credentials, options)
    .then((login) => {
        token = login.data.token;
        options.headers = {'Authorization': `Bearer ${token}`};

        return axios.get(`https://${config.buckutt.api}/users/search?q=${notRemoved}&embed=${embedUsers}`, options);
    })
    .then((members) => {
        buckuttMembers = members.data.map(member => ({
            mail: member.mail,
            current: {
                contributor   : (member.groups.findIndex(group => group.id === config.buckutt.contributorGroup && group._through.period.id === config.buckutt.defaultPeriod) > -1),
                nonContributor: (member.groups.findIndex(group => group.id === config.buckutt.nonContributorGroup && group._through.period.id === config.buckutt.defaultPeriod) > -1)
            }
        }));

        return axios.get(`http://${config.erp.host}/api/index.php/members?DOLAPIKEY=${config.erp.key}&limit=100`);
    })
    .then((users) => {
        const students = users.data.map(etu => ({
            etuId      : etu.array_options.options_student,
            firstname  : etu.firstname,
            lastname   : etu.lastname,
            login      : etu.login,
            mail       : etu.email,
            contributor: (etu.datefin <= Math.ceil(new Date().getTime()/1000))
        }));

        students.forEach((student) => {
            axios.get(`http://${config.erp.host}/api/index.php/members?DOLAPIKEY=${config.erp.key}&limit=100`);
        });
    })
    .catch((error) => {
        console.log(error);
    });