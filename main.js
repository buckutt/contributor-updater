const axios   = require('axios');
const Promise = require('bluebird');
const fs      = require('fs');
const https   = require('https');
const config  = require('./config');

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
            id  : member.id,
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

        const usersCreation = [];

        students.forEach((student) => {
            const memberIndex = buckuttMembers.findIndex(m => m.mail === student.mail);

            if (memberIndex === -1) {
                const newUser = {
                    firstname: student.firstname,
                    lastname : student.lastname,
                    pin      : 'notGenYet',
                    password : 'notGenYet',
                    mail     : student.mail
                };

                const newMols = [{
                    type: 'etuId',
                    data: `22000000${student.etuId}`
                }, {
                    type: 'etuMail',
                    data: student.mail
                }, {
                    type: 'etuLogin',
                    data: student.login
                }, {
                    type: 'etuNumber',
                    data: student.etuId
                }];

                usersCreation.push(createUser(newUser, newMols, student.contributor));
            } else {
                buckuttMembers[memberIndex].isContributor = student.contributor;
            }

            return Promise.all(usersCreation);
        })
        .then((usersCreated) => {
            buckuttMembers = buckuttMembers.concat(usersCreated);

            const membershipRequests = [];

            buckuttMembers.forEach((member) => {
                if (member.current.contributor && !member.isContributor) {
                    membershipRequests.push(removeUserFromGroup(member.id, config.buckutt.contributorGroup, config.buckutt.defaultPeriod));
                } else if (!member.current.contributor && member.isContributor) {
                    membershipRequests.push(addUserToGroup(member.id, config.buckutt.contributorGroup, config.buckutt.defaultPeriod));
                }

                if (!member.current.nonContributor) {
                    membershipRequests.push(addUserToGroup(member.id, config.buckutt.nonContributorGroup, config.buckutt.defaultPeriod));
                }
            });

            return Promise.all(membershipRequests);
        })
        .then(() => console.log('Sync finished.'));
    })
    .catch(error => console.log(error));


function createUser(user, mols, contributor) {
    let createdUser = {};
    return axios.post(`https://${config.buckutt.api}/users`, user, options)
        .then((newUser) => {
            createdUser = {
                id     : newUser.data.id,
                mail   : newUser.data.mail,
                current: {
                    contributor   : false,
                    nonContributor: false
                },
                isContributor: contributor
            };

            const molsToCreate = mols.map(mol => {
                mol.User_id = newUser.data.id;
                return mol;
            });

            const molsRequests = [];

            molsToCreate.forEach(mol => molsRequests.push(axios.post(`https://${config.buckutt.api}/meanoflogins`, mol, options)));

            return Promise.all(molsRequests);
        })
        .then(() => Promise.resolve(createdUser));
}

function addUserToGroup(userId, groupId, periodId) {
    const filter = { Period_id: periodId };
    return axios.post(`https://${config.buckutt.api}/users/${userId}/groups/${groupId}`, filter, options);
}

function removeUserFromGroup(userId, groupId, periodId) {
    const filter = { Period_id: periodId };
    return axios.delete(`https://${config.buckutt.api}/users/${userId}/groups/${groupId}`, filter, options);
}
